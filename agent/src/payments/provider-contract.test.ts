/** The same contract run against every PaymentProvider: link in the reply, signed webhook is the only way to collected, replay/idempotency on signed content, mismatches, tenant scoping. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { verifyLedger } from "../ledger/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { handleWebhook } from "./webhook.js";
import { KITS, type ProviderKit } from "./provider-kit.js";
import { ask, NOW, seedTenant } from "./test-helpers.js";

let db: TestDb;
let kernel: KernelBridge;
beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

describe.each(KITS.map((k) => [k.name, k] as [string, ProviderKit]))("PaymentProvider contract: %s", (_n, kit) => {
  const T = { id: `tenant-contract-${kit.name}`, name: `FICTIONAL: Contract ${kit.name}` };
  // thread ids are global primary keys, so each provider's tenant gets its own
  const tid = (short: string) => `${kit.name}:${short}`;
  const deps = () => ({ pool: db.pool, kernel, payments: kit.provider });
  async function quoted(short: string) {
    const threadId = tid(short);
    const card = await seedTenant(db.pool, kernel, T);
    const res = await ask(db.pool, kernel, kit.provider, T, card, threadId);
    if (res.outcome.kind !== "quote") throw new Error("expected quote");
    const row = await withTenant(db.pool, T.id, (c) => c.query("SELECT provider, provider_link_id, link_url FROM payments WHERE thread_id=$1", [threadId]));
    return { total: res.outcome.total, linkId: row.rows[0].provider_link_id as string, reply: res.reply, row: row.rows[0] };
  }
  const state = (short: string) =>
    withTenant(db.pool, T.id, async (c) => ({
      thread: (await c.query("SELECT state FROM threads WHERE id=$1", [tid(short)])).rows[0]?.state as string,
      collected: (await c.query("SELECT payload FROM ledger_entries WHERE thread_id=$1 AND type='collected'", [tid(short)])).rows,
      mismatch: (await c.query("SELECT payload FROM ledger_entries WHERE thread_id=$1 AND type='payment_mismatch'", [tid(short)])).rows,
    }));
  const ledgerCount = async () => ((await db.pool.query("SELECT count(*)::int AS n FROM ledger_entries WHERE tenant_id=$1", [T.id])).rows[0] as { n: number }).n;

  it("the quote reply carries this provider's simulated link and the payment row names the provider", async () => {
    const q = await quoted("c-1");
    expect(kit.linkPattern.test(q.reply)).toBe(true);
    expect(q.reply).toContain("simulation");
    expect(q.row.provider).toBe(kit.name);
  });

  it("a signed paid event for the exact amount collects once, with a verified chain", async () => {
    const q = await quoted("c-2");
    const ev = kit.paid({ linkId: q.linkId, tenantId: T.id, amount: q.total });
    expect(await handleWebhook(deps(), ev.body, ev.headers, NOW)).toMatchObject({ status: "collected", threadId: tid("c-2") });
    const s = await state("c-2");
    expect(s.thread).toBe("collected");
    expect(s.collected).toHaveLength(1);
    expect(s.collected[0].payload).toMatchObject({ amountMinor: q.total, currency: "INR", provider: kit.name });
    expect((await verifyLedger(db.pool, kernel)).ok).toBe(true);
  });

  it("forged, missing, wrong-key and tampered requests are rejected and change nothing", async () => {
    const q = await quoted("c-3");
    const ev = kit.paid({ linkId: q.linkId, tenantId: T.id, amount: q.total });
    const before = await ledgerCount();
    for (const [name, h, body] of kit.forgeries(ev)) expect(await handleWebhook(deps(), body, h, NOW), name).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(await ledgerCount()).toBe(before);
    expect((await state("c-3")).thread).toBe("quoted");
  });

  it("resending the same signed delivery is a duplicate; ledger unchanged", async () => {
    const q = await quoted("c-4");
    const ev = kit.paid({ linkId: q.linkId, tenantId: T.id, amount: q.total });
    expect((await handleWebhook(deps(), ev.body, ev.headers, NOW)).status).toBe("collected");
    const before = await ledgerCount();
    for (let i = 0; i < 3; i++) expect(await handleWebhook(deps(), ev.body, ev.headers, NOW)).toEqual({ status: "duplicate" });
    expect(await ledgerCount()).toBe(before);
  });

  it("a wrong amount or currency is a flagged mismatch, not a collection; the right event then still collects", async () => {
    const q = await quoted("c-5");
    const a = kit.paid({ linkId: q.linkId, tenantId: T.id, amount: q.total - 1, eventId: "evt_c5a" });
    const c = kit.paid({ linkId: q.linkId, tenantId: T.id, amount: q.total, currency: "USD", eventId: "evt_c5b" });
    expect(await handleWebhook(deps(), a.body, a.headers, NOW)).toMatchObject({ status: "mismatch", reason: "amount_mismatch" });
    expect(await handleWebhook(deps(), c.body, c.headers, NOW)).toMatchObject({ status: "mismatch", reason: "currency_mismatch" });
    expect((await state("c-5")).collected).toEqual([]);
    const ok = kit.paid({ linkId: q.linkId, tenantId: T.id, amount: q.total, eventId: "evt_c5c" });
    expect((await handleWebhook(deps(), ok.body, ok.headers, NOW)).status).toBe("collected");
  });

  it("another tenant's link id collects nothing", async () => {
    const q = await quoted("c-6");
    const T2 = { id: `${T.id}-other`, name: "FICTIONAL: Other" };
    await seedTenant(db.pool, kernel, T2);
    const cross = kit.paid({ linkId: q.linkId, tenantId: T2.id, amount: q.total, eventId: "evt_c6" });
    expect(await handleWebhook(deps(), cross.body, cross.headers, NOW)).toMatchObject({ status: "ignored", reason: "unknown_link" });
    expect((await state("c-6")).collected).toEqual([]);
  });
});
