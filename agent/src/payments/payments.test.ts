import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { setKillSwitch } from "../killswitch/index.js";
import { verifyLedger } from "../ledger/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { requestPaymentLink } from "./issue.js";
import { razorpaySim } from "./razorpay-sim.js";
import { handleWebhook } from "./webhook.js";
import { ask, NOW, paidEvent, seedTenant, sign, TEST_SECRET } from "./test-helpers.js";

let db: TestDb;
let kernel: KernelBridge;
beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

const T1 = { id: "tenant-pay-one", name: "FICTIONAL: Pay One Banquets" };
const provider = razorpaySim({ webhookSecret: TEST_SECRET });

describe("payment link in the reply", () => {
  it("a quote reply carries a simulated link for exactly the kernel total, in paise, and the link is a ledger entry", async () => {
    const card = await seedTenant(db.pool, kernel, T1);
    const res = await ask(db.pool, kernel, provider, T1, card, "pay-thread-1");
    if (res.outcome.kind !== "quote") throw new Error("expected a quote");
    const m = /https:\/\/rzp\.sim\.invalid\/pl_[a-z0-9]+/.exec(res.reply);
    expect(m).not.toBeNull();
    expect(res.reply).toContain("simulation");
    const pay = await withTenant(db.pool, T1.id, (c) => c.query("SELECT amount_minor::int AS amount, currency, link_url, status FROM payments WHERE thread_id='pay-thread-1'"));
    expect(pay.rows).toEqual([{ amount: res.outcome.total, currency: "INR", link_url: m![0], status: "created" }]);
    const led = await withTenant(db.pool, T1.id, (c) => c.query("SELECT payload FROM ledger_entries WHERE thread_id='pay-thread-1' AND type='payment_link'"));
    expect(led.rows[0]?.payload).toMatchObject({ amountMinor: res.outcome.total, currency: "INR", url: m![0], provider: "razorpay-sim" });
  });

  it("no provider configured: the reply carries no link (existing behaviour unchanged)", async () => {
    const card = await seedTenant(db.pool, kernel, T1);
    const res = await ask(db.pool, kernel, undefined, T1, card, "pay-thread-nolink");
    expect(res.reply).not.toContain("rzp.sim.invalid");
  });
});

describe("kill switch: a payment link is never issued while it is on", () => {
  const OWNER = (t: { id: string }) => ({ memberId: `${t.id}:legacy-seed-owner` });
  const linkCount = async (threadId: string) =>
    withTenant(db.pool, T1.id, async (c) => ({
      payments: (await c.query("SELECT 1 FROM payments WHERE thread_id=$1", [threadId])).rowCount,
      ledger: (await c.query("SELECT 1 FROM ledger_entries WHERE thread_id=$1 AND type='payment_link'", [threadId])).rowCount,
    }));

  it("a quote issued earlier gets no link on request while the tenant switch is on, and gets one after it is flipped back", async () => {
    const card = await seedTenant(db.pool, kernel, T1);
    await ask(db.pool, kernel, undefined, T1, card, "pay-ks-1"); // quote without a link
    await setKillSwitch({ pool: db.pool, kernel }, { target: { kind: "tenant", tenantId: T1.id }, on: true, actor: OWNER(T1), now: NOW });
    const deps = { pool: db.pool, kernel, payments: provider };
    expect(await requestPaymentLink(deps, { tenantId: T1.id, threadId: "pay-ks-1", now: NOW })).toEqual({ ok: false, reason: "kill_switch" });
    expect(await linkCount("pay-ks-1")).toEqual({ payments: 0, ledger: 0 });
    await setKillSwitch({ pool: db.pool, kernel }, { target: { kind: "tenant", tenantId: T1.id }, on: false, actor: OWNER(T1), now: NOW });
    const again = await requestPaymentLink(deps, { tenantId: T1.id, threadId: "pay-ks-1", now: NOW });
    expect(again.ok).toBe(true);
    expect(await linkCount("pay-ks-1")).toEqual({ payments: 1, ledger: 1 });
  });

  it("a global switch also blocks it, and a fresh enquiry while on gets a kill_switch refusal with no link at all", async () => {
    const card = await seedTenant(db.pool, kernel, T1);
    await ask(db.pool, kernel, undefined, T1, card, "pay-ks-2");
    await setKillSwitch({ pool: db.pool, kernel }, { target: { kind: "global" }, on: true, actor: { operator: "fictional-operator" }, now: NOW });
    try {
      expect(await requestPaymentLink({ pool: db.pool, kernel, payments: provider }, { tenantId: T1.id, threadId: "pay-ks-2", now: NOW })).toEqual({ ok: false, reason: "kill_switch" });
      const res = await ask(db.pool, kernel, provider, T1, card, "pay-ks-3");
      expect(res.outcome).toMatchObject({ kind: "refusal", reason: "kill_switch" });
      expect(res.reply).not.toContain("rzp.sim.invalid");
      expect(await linkCount("pay-ks-2")).toEqual({ payments: 0, ledger: 0 });
      expect(await linkCount("pay-ks-3")).toEqual({ payments: 0, ledger: 0 });
    } finally {
      await setKillSwitch({ pool: db.pool, kernel }, { target: { kind: "global" }, on: false, actor: { operator: "fictional-operator" }, now: NOW });
    }
  });
});

describe("webhook: the only path to a collected entry", () => {
  const deps = () => ({ pool: db.pool, kernel, payments: provider });
  async function quoted(threadId: string) {
    const card = await seedTenant(db.pool, kernel, T1);
    const res = await ask(db.pool, kernel, provider, T1, card, threadId);
    if (res.outcome.kind !== "quote") throw new Error("expected quote");
    const row = await withTenant(db.pool, T1.id, (c) => c.query("SELECT provider_link_id FROM payments WHERE thread_id=$1", [threadId]));
    return { total: res.outcome.total, linkId: row.rows[0].provider_link_id as string };
  }
  const state = (threadId: string) =>
    withTenant(db.pool, T1.id, async (c) => ({
      thread: (await c.query("SELECT state FROM threads WHERE id=$1", [threadId])).rows[0]?.state as string,
      collected: (await c.query("SELECT payload FROM ledger_entries WHERE thread_id=$1 AND type='collected'", [threadId])).rows,
      mismatch: (await c.query("SELECT payload FROM ledger_entries WHERE thread_id=$1 AND type='payment_mismatch' ORDER BY tenant_seq", [threadId])).rows,
    }));

  it("a correctly signed paid event for the exact amount flips the thread to collected and writes one collected entry", async () => {
    const { total, linkId } = await quoted("wh-1");
    const ev = paidEvent({ linkId, tenantId: T1.id, amount: total, eventId: "evt_wh_1" });
    const r = await handleWebhook(deps(), ev.body, ev.headers, NOW);
    expect(r).toMatchObject({ status: "collected", threadId: "wh-1" });
    const s = await state("wh-1");
    expect(s.thread).toBe("collected");
    expect(s.collected).toHaveLength(1);
    expect(s.collected[0].payload).toMatchObject({ amountMinor: total, currency: "INR", eventId: "evt_wh_1", providerPaymentId: "pay_sim_0001" });
    expect((await verifyLedger(db.pool, kernel)).ok).toBe(true);
  });

  it("bad, missing or wrong-key signatures are rejected and change nothing; a tampered body fails too", async () => {
    const { total, linkId } = await quoted("wh-2");
    const ev = paidEvent({ linkId, tenantId: T1.id, amount: total, eventId: "evt_wh_2" });
    const cases: [string, Record<string, string | undefined>, string][] = [
      ["bad", { ...ev.headers, "x-razorpay-signature": "0".repeat(64) }, ev.body],
      ["missing", { "x-razorpay-event-id": "evt_wh_2" }, ev.body],
      ["garbage", { ...ev.headers, "x-razorpay-signature": "not-hex" }, ev.body],
      ["wrong key", { ...ev.headers, "x-razorpay-signature": sign(ev.body, "another-secret") }, ev.body],
      ["tampered body", ev.headers, ev.body.replace(String(total), String(total - 1))],
    ];
    for (const [name, h, body] of cases) expect(await handleWebhook(deps(), body, h, NOW), name).toEqual({ status: "rejected", reason: "bad_signature" });
    const s = await state("wh-2");
    expect(s).toMatchObject({ thread: "quoted", collected: [], mismatch: [] });
    expect((await withTenant(db.pool, T1.id, (c) => c.query("SELECT 1 FROM payment_events WHERE event_id='evt_wh_2'"))).rowCount).toBe(0);
  });

  it("replaying an event id is ignored: still one collected entry", async () => {
    const { total, linkId } = await quoted("wh-3");
    const ev = paidEvent({ linkId, tenantId: T1.id, amount: total, eventId: "evt_wh_3" });
    expect((await handleWebhook(deps(), ev.body, ev.headers, NOW)).status).toBe("collected");
    expect(await handleWebhook(deps(), ev.body, ev.headers, "2026-11-07T10:05:00Z")).toMatchObject({ status: "duplicate" });
    expect((await state("wh-3")).collected).toHaveLength(1);
  });

  it("a different event id for an already-collected payment is flagged, not collected twice", async () => {
    const { total, linkId } = await quoted("wh-4");
    const a = paidEvent({ linkId, tenantId: T1.id, amount: total, eventId: "evt_wh_4a" });
    const b = paidEvent({ linkId, tenantId: T1.id, amount: total, eventId: "evt_wh_4b" });
    await handleWebhook(deps(), a.body, a.headers, NOW);
    expect(await handleWebhook(deps(), b.body, b.headers, NOW)).toMatchObject({ status: "mismatch", reason: "already_collected" });
    const s = await state("wh-4");
    expect(s.collected).toHaveLength(1);
    expect(s.mismatch).toHaveLength(1);
  });

  it("wrong amount or currency: flagged as a mismatch (ledger entry), no collected entry, thread stays quoted", async () => {
    const { total, linkId } = await quoted("wh-5");
    const wrongAmount = paidEvent({ linkId, tenantId: T1.id, amount: total - 100, eventId: "evt_wh_5a" });
    const wrongCurrency = paidEvent({ linkId, tenantId: T1.id, amount: total, currency: "USD", eventId: "evt_wh_5b" });
    expect(await handleWebhook(deps(), wrongAmount.body, wrongAmount.headers, NOW)).toMatchObject({ status: "mismatch", reason: "amount_mismatch" });
    expect(await handleWebhook(deps(), wrongCurrency.body, wrongCurrency.headers, NOW)).toMatchObject({ status: "mismatch", reason: "currency_mismatch" });
    const s = await state("wh-5");
    expect(s.thread).toBe("quoted");
    expect(s.collected).toEqual([]);
    expect(s.mismatch.map((m) => m.payload.reason)).toEqual(["amount_mismatch", "currency_mismatch"]);
    // a correct event afterwards still collects
    const ok = paidEvent({ linkId, tenantId: T1.id, amount: total, eventId: "evt_wh_5c" });
    expect((await handleWebhook(deps(), ok.body, ok.headers, NOW)).status).toBe("collected");
  });

  it("an unknown link (or another tenant's link id) collects nothing", async () => {
    const { total, linkId } = await quoted("wh-6");
    const unknown = paidEvent({ linkId: "pl_doesnotexist", tenantId: T1.id, amount: total, eventId: "evt_wh_6a" });
    expect(await handleWebhook(deps(), unknown.body, unknown.headers, NOW)).toMatchObject({ status: "ignored", reason: "unknown_link" });
    const T2 = { id: "tenant-pay-two", name: "FICTIONAL: Pay Two Banquets" };
    await seedTenant(db.pool, kernel, T2);
    const cross = paidEvent({ linkId, tenantId: T2.id, amount: total, eventId: "evt_wh_6b" });
    expect(await handleWebhook(deps(), cross.body, cross.headers, NOW)).toMatchObject({ status: "ignored", reason: "unknown_link" });
    expect((await state("wh-6")).collected).toEqual([]);
  });
});
