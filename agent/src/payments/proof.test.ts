import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { collectingNotifier } from "../escalation/index.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { proofForThread } from "./proof.js";
import { razorpaySim } from "./razorpay-sim.js";
import { handleWebhook } from "./webhook.js";
import { ask, NOW, paidEvent, seedTenant, TEST_SECRET } from "./test-helpers.js";

let db: TestDb;
let kernel: KernelBridge;
beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

const T1 = { id: "tenant-proof-one", name: "FICTIONAL: Proof One Banquets" };
const T2 = { id: "tenant-proof-two", name: "FICTIONAL: Proof Two Banquets" };
const provider = razorpaySim({ webhookSecret: TEST_SECRET });
const deps = () => ({ pool: db.pool, kernel, payments: provider });

async function quotedThread(t: { id: string; name: string }, threadId: string) {
  const card = await seedTenant(db.pool, kernel, t);
  const res = await ask(db.pool, kernel, provider, t, card, threadId);
  if (res.outcome.kind !== "quote") throw new Error("expected quote");
  const row = await withTenant(db.pool, t.id, (c) => c.query("SELECT provider_link_id FROM payments WHERE thread_id=$1", [threadId]));
  return { card, total: res.outcome.total, linkId: row.rows[0].provider_link_id as string };
}
const pay = async (t: { id: string }, linkId: string, amount: number, eventId: string) => {
  const ev = paidEvent({ linkId, tenantId: t.id, amount, eventId });
  return handleWebhook(deps(), ev.body, ev.headers, NOW);
};

describe("per-job proof: billable yes/no and why", () => {
  it("agent-issued quote + webhook collection: billable, with the chain of entries", async () => {
    const { total, linkId } = await quotedThread(T1, "pf-1");
    await pay(T1, linkId, total, "evt_pf_1");
    const p = await proofForThread(db.pool, kernel, { tenantId: T1.id, threadId: "pf-1" });
    expect(p.billable).toBe("yes");
    expect(p.why).toMatch(/agent-issued quote .*collected via webhook/);
    expect(p.amountMinor).toBe(total);
    expect(p.chain.map((e) => e.type).filter((t) => ["quote", "payment_link", "collected"].includes(t))).toEqual(["quote", "payment_link", "collected"]);
    expect(p.chainVerified).toBe(true);
  });

  it("quoted but not collected: not billable, says so", async () => {
    await quotedThread(T1, "pf-2");
    const p = await proofForThread(db.pool, kernel, { tenantId: T1.id, threadId: "pf-2" });
    expect(p).toMatchObject({ billable: "no", reason: "not_collected" });
    expect(p.why).toMatch(/no collected entry/);
  });

  it("a mismatched payment is not billable", async () => {
    const { total, linkId } = await quotedThread(T1, "pf-3");
    await pay(T1, linkId, total - 1, "evt_pf_3");
    expect(await proofForThread(db.pool, kernel, { tenantId: T1.id, threadId: "pf-3" })).toMatchObject({ billable: "no", reason: "not_collected" });
  });

  it("a thread with no agent-issued quote (refusal only) is not billable", async () => {
    const card = await seedTenant(db.pool, kernel, T1);
    await handleEnquiry(
      { pool: db.pool, kernel, notifier: collectingNotifier([]), payments: provider },
      { tenant: T1, threadId: "pf-4", customerRef: "c4", rateCard: card, now: NOW, availability: { blockedDates: [] }, message: "?", fields: { language: "en", confidenceBps: 9000 } },
    );
    expect(await proofForThread(db.pool, kernel, { tenantId: T1.id, threadId: "pf-4" })).toMatchObject({ billable: "no", reason: "no_agent_quote" });
  });

  it("owner-priced jobs are not billable even when collected", async () => {
    const { total, linkId } = await quotedThread(T1, "pf-5");
    await withTenant(db.pool, T1.id, (c) =>
      appendEntry(c, kernel, { tenantId: T1.id, threadId: "pf-5", at: NOW, type: "owner_message", payload: { command: "price", text: "fictional: owner quoted 5000 directly", memberId: "m" } }),
    );
    await pay(T1, linkId, total, "evt_pf_5");
    const p = await proofForThread(db.pool, kernel, { tenantId: T1.id, threadId: "pf-5" });
    expect(p).toMatchObject({ billable: "no", reason: "owner_priced" });
  });

  it("a correction against the collected entry (refund/dispute) makes it not billable", async () => {
    const { total, linkId } = await quotedThread(T1, "pf-6");
    await pay(T1, linkId, total, "evt_pf_6");
    const { appendCorrection } = await import("../ledger/index.js");
    const col = (await db.pool.query("SELECT seq::int AS seq FROM ledger_entries WHERE thread_id='pf-6' AND type='collected'")).rows[0];
    await withTenant(db.pool, T1.id, (c) => appendCorrection(c, kernel, { seq: col.seq }, { reason: "fictional refund" }, NOW));
    expect(await proofForThread(db.pool, kernel, { tenantId: T1.id, threadId: "pf-6" })).toMatchObject({ billable: "no", reason: "collection_corrected" });
  });

  it("a broken hash chain is not billable (proof refuses to vouch for a tampered ledger)", async () => {
    const { total, linkId } = await quotedThread(T2, "pf-7");
    await pay(T2, linkId, total, "evt_pf_7");
    const c = await db.pool.connect();
    try {
      await c.query("ALTER TABLE ledger_entries DISABLE TRIGGER USER");
      await c.query(`UPDATE ledger_entries SET payload = jsonb_set(payload, '{amountMinor}', '1') WHERE thread_id='pf-7' AND type='collected'`);
      await c.query("ALTER TABLE ledger_entries ENABLE TRIGGER USER");
    } finally {
      c.release();
    }
    expect(await proofForThread(db.pool, kernel, { tenantId: T2.id, threadId: "pf-7" })).toMatchObject({ billable: "no", reason: "chain_broken", chainVerified: false });
  });

  it("another tenant's thread is unknown to this tenant's proof", async () => {
    expect(await proofForThread(db.pool, kernel, { tenantId: T1.id, threadId: "pf-7" })).toMatchObject({ billable: "no", reason: "unknown_thread" });
  });
});

describe("payments tables: tenant isolation", () => {
  it("a tenant sees only its own payments and events, and cannot insert one for another tenant", async () => {
    const mine = await withTenant(db.pool, T1.id, (c) => c.query("SELECT DISTINCT tenant_id FROM payments"));
    expect(mine.rows.map((r) => r.tenant_id)).toEqual([T1.id]);
    const ev = await withTenant(db.pool, T1.id, (c) => c.query("SELECT DISTINCT tenant_id FROM payment_events"));
    expect(ev.rows.map((r) => r.tenant_id)).toEqual([T1.id]);
    await expect(
      withTenant(db.pool, T1.id, (c) =>
        c.query("INSERT INTO payment_events (tenant_id, provider, event_id, outcome, received_at) VALUES ($1,'razorpay-sim','x','ignored',now())", [T2.id]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(db.pool, T1.id, (c) => c.query("UPDATE payments SET amount_minor = 1 WHERE tenant_id = $1", [T2.id])).then((r) => {
        if (r.rowCount !== 0) throw new Error("cross-tenant update touched rows");
      }),
    ).resolves.toBeUndefined();
  });

  it("the app role cannot delete payments or events", async () => {
    await expect(withTenant(db.pool, T1.id, (c) => c.query("DELETE FROM payments"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db.pool, T1.id, (c) => c.query("UPDATE payment_events SET outcome='collected'"))).rejects.toThrow(/permission denied/);
  });
});

describe("guard: the webhook is the only writer of a collected ledger entry", () => {
  const SRC = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts") && !/\.test\.ts$/.test(p) && !p.endsWith("test-helpers.ts")) out.push(p);
    }
    return out;
  };
  // A write is an appendEntry/INSERT with type "collected"; reading or comparing ('collected' in a SELECT/state) is fine.
  const WRITES = /type:\s*["']collected["']|'collected'\s*,\s*\$|INSERT INTO ledger_entries/;

  it("only payments/webhook.ts (and the generic ledger insert) can produce a collected ledger entry", () => {
    const hits = walk(SRC)
      .filter((p) => WRITES.test(readFileSync(p, "utf8")))
      .map((p) => path.relative(SRC, p))
      .sort();
    expect(hits).toEqual(["ledger/index.ts", "payments/webhook.ts"]);
  });

  it("no other source mentions the collected ledger type at all (state names aside)", () => {
    const hits = walk(SRC)
      .filter((p) => /["']collected["']/.test(readFileSync(p, "utf8")))
      .map((p) => path.relative(SRC, p))
      .sort();
    // ledger/index.ts: the type union; proof.ts and owner/digest.ts (T17, a read-only SUM for the daily digest): read it; webhook.ts:
    // writes it; simulator/ack: thread state label only if present; server/describe-ledger-entry.ts (V4): a read-only one-line
    // label for the owner console's inbox/thread-detail screens, same as proof.ts/digest.ts's read-only use.
    expect(
      hits.filter((h) => !["ledger/index.ts", "payments/proof.ts", "payments/webhook.ts", "owner/digest.ts", "server/describe-ledger-entry.ts"].includes(h)),
    ).toEqual([]);
  });

  it("the guard bites: a planted writer is caught by the same pattern", () => {
    expect(WRITES.test(`await appendEntry(c, k, { type: "collected", payload: {} })`)).toBe(true);
    expect(WRITES.test(`SELECT 1 FROM ledger_entries WHERE type='collected'`)).toBe(false);
  });
});
