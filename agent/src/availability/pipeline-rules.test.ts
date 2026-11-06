import { seedApprovedCard } from "../ratecard/legacy.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectingNotifier } from "../escalation/index.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import type { Quote } from "../kernel/types.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { REPO_ROOT } from "../simulator/run-fixture.js";
import { runDueTimers } from "../timers/run.js";
import { addBlock, defaultResource, nativeAvailability } from "./native.js";
import { withTenant } from "../tenancy/with-tenant.js";

type Card = Record<string, unknown> & { rules: { ruleId: string; charge: { amount?: number } }[]; version: number };
let db: TestDb;
let kernel: KernelBridge;
let banquet: Card;
let n = 0;
const TENANT = { id: "tenant-rules", name: "FICTIONAL: Rules Hall" };
const T0 = "2026-11-07T10:00:00Z";
const plusHours = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3_600_000).toISOString().replace(".000Z", "Z");

beforeAll(async () => {
  kernel = await loadKernel();
  banquet = JSON.parse(await readFile(path.join(REPO_ROOT, "rate-cards/fictional-banquet.json"), "utf8")) as Card;
});
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

/** A fresh tenant per test so dates never collide between tests. */
function freshTenant() {
  return { id: `tenant-rules-${++n}`, name: TENANT.name };
}

async function enquire(
  tenant: { id: string; name: string },
  customer: string,
  date: string,
  now: string,
  opts: { card?: Card; guests?: number; fields?: Record<string, unknown> } = {},
) {
  const card = opts.card ?? banquet;
  await seedApprovedCard({ pool: db.pool, kernel }, { tenant, card, now: T0 });
  return handleEnquiry(
    { pool: db.pool, kernel, notifier: collectingNotifier([]), availability: nativeAvailability },
    {
      tenant,
      threadId: `${tenant.id}:thread:${customer}`,
      customerRef: customer,
      rateCard: card,
      now,
      availability: { blockedDates: [] },
      message: "(fixture)",
      fields: opts.fields ?? { service: "banquet", date, guestCount: opts.guests ?? 120, language: "en", confidenceBps: 9000 },
    },
  );
}

describe("taken dates", () => {
  it("concurrent enquiries for the same Saturday: exactly one quote, one hold, one refusal", async () => {
    const t = freshTenant();
    const results = await Promise.all(["c1", "c2", "c3", "c4"].map((c) => enquire(t, c, "2026-12-12", T0)));
    expect(results.filter((r) => r.outcome.kind === "quote")).toHaveLength(1);
    expect(results.filter((r) => r.outcome.kind === "refusal" && r.outcome.reason === "date_unavailable")).toHaveLength(3);
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM holds WHERE tenant_id=$1 AND status='active'", [t.id]);
    expect(rows[0].n).toBe(1);
  });

  it("an expired hold stops blocking at read time, before any worker ran", async () => {
    const t = freshTenant();
    expect((await enquire(t, "a", "2026-12-12", T0)).outcome.kind).toBe("quote");
    expect((await enquire(t, "b", "2026-12-12", plusHours(T0, 47))).outcome.kind).toBe("refusal");
    const late = await enquire(t, "b", "2026-12-12", plusHours(T0, 49));
    expect(late.outcome.kind).toBe("quote");
    // the swept hold is logged as expired, and the timer for it is a harmless no-op afterwards
    const actions = (await db.pool.query("SELECT payload->>'action' AS a FROM ledger_entries WHERE tenant_id=$1 AND type='hold' ORDER BY seq", [t.id])).rows.map((r) => r.a);
    expect(actions).toEqual(["placed", "expired", "placed"]);
    await runDueTimers(db.pool, plusHours(T0, 100), { kernel });
    const holds = (await db.pool.query("SELECT status FROM holds WHERE tenant_id=$1", [t.id])).rows.map((r) => r.status);
    expect(holds).toEqual(["expired", "expired"]);
    const swept = (await db.pool.query("SELECT count(*)::int AS n FROM ledger_entries WHERE tenant_id=$1 AND type='hold' AND payload->>'action'='expired'", [t.id])).rows[0].n;
    expect(swept).toBe(2); // each expiry logged exactly once, whether the sweep or the timer got there first
  });

  it("static blocked dates passed by the caller still refuse", async () => {
    const t = freshTenant();
    await seedApprovedCard({ pool: db.pool, kernel }, { tenant: t, card: banquet, now: T0 });
    const r = await handleEnquiry(
      { pool: db.pool, kernel, notifier: collectingNotifier([]), availability: nativeAvailability },
      {
        tenant: t, threadId: `${t.id}:th`, customerRef: "x", rateCard: banquet, now: T0,
        availability: { blockedDates: ["2026-12-12"] }, message: "m",
        fields: { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9000 },
      },
    );
    expect(r.outcome).toMatchObject({ kind: "refusal", reason: "date_unavailable" });
  });

  it("alternatives are offered only when the card allows it", async () => {
    const t = freshTenant();
    await enquire(t, "a", "2026-12-12", T0);
    const off = await enquire(t, "b", "2026-12-12", T0);
    expect(off.reply).not.toMatch(/nearby/i);

    const t2 = freshTenant();
    const withAlts = { ...banquet, offerAlternatives: true } as Card;
    await enquire(t2, "a", "2026-12-12", T0, { card: withAlts });
    const res = await withTenant(db.pool, t2.id, async (c) => addBlock(c, { tenantId: t2.id, resourceId: await defaultResource(c, t2.id), start: "2026-12-13", end: "2026-12-13", reason: "x", createdBy: null }));
    void res;
    const on = await enquire(t2, "b", "2026-12-12", T0, { card: withAlts });
    expect(on.outcome).toMatchObject({ kind: "refusal", reason: "date_unavailable" });
    expect(on.reply).toMatch(/nearby dates are free/i);
    expect(on.reply).not.toContain("13 Dec 2026"); // blocked, so not offered
    expect(on.reply).toContain("11 Dec 2026");
    expect(on.reply).not.toMatch(/₹/);
    // suggesting dates does not hold them
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM holds WHERE tenant_id=$1 AND status='active'", [t2.id]);
    expect(rows[0].n).toBe(1);
  });
});

describe("expired quotes are re-evaluated, never honoured", () => {
  const back = { language: "en", confidenceBps: 9000 };

  it("a card whose price changed since the quote gives the new price after the old quote expired", async () => {
    const t = freshTenant();
    const first = await enquire(t, "a", "2026-12-12", T0);
    const q1 = first.outcome as Quote;
    expect(q1.kind).toBe("quote");
    const repriced = {
      ...banquet,
      version: 2,
      rules: banquet.rules.map((r) => (r.ruleId === "hall-weekend" ? { ...r, charge: { ...r.charge, amount: 30_000_000 } } : r)),
    } as Card;
    // past validUntil (7 days)
    const later = await enquire(t, "a", "2026-12-12", plusHours(T0, 24 * 8), { card: repriced, fields: back });
    const q2 = later.outcome as Quote;
    expect(q2.kind).toBe("quote");
    expect(q2.total).toBeGreaterThan(q1.total);
    expect(q2.rateCardHash).not.toBe(q1.rateCardHash);
    expect(later.reply).toMatch(/earlier quote has expired/i);
  });

  it("a message inside the validity window is not told the quote expired", async () => {
    const t = freshTenant();
    await enquire(t, "a", "2026-12-12", T0);
    const within = await enquire(t, "a", "2026-12-12", plusHours(T0, 24 * 3), { fields: back });
    expect(within.outcome.kind).toBe("quote");
    expect(within.reply).not.toMatch(/expired/i);
  });

  it("a date taken since the quote gives a refusal, not the old quote", async () => {
    const t = freshTenant();
    expect((await enquire(t, "a", "2026-12-12", T0)).outcome.kind).toBe("quote");
    expect((await enquire(t, "b", "2026-12-12", plusHours(T0, 24 * 7))).outcome.kind).toBe("quote");
    const back8 = await enquire(t, "a", "2026-12-12", plusHours(T0, 24 * 8), { fields: back });
    expect(back8.outcome).toMatchObject({ kind: "refusal", reason: "date_unavailable" });
    expect(back8.reply).toMatch(/earlier quote has expired/i);
    expect(back8.reply).not.toMatch(/₹/);
  });
});
