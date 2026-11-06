import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { runFixture } from "../simulator/run-fixture.js";
import type { Quote } from "../kernel/types.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe("holds through the pipeline (fixtures/holds-saturday.json)", () => {
  it("first enquiry gets a quote and a hold, second is told the date is unavailable, 49h later the hold is released and a third quotes", async () => {
    const r = await runFixture("fixtures/holds-saturday.json", { pool: db.pool });
    expect(r.turns).toHaveLength(3);
    const [a, b, c] = r.turns;

    expect(a?.quote.kind).toBe("quote");
    expect(a?.reply).toContain("held for you until 9 Nov 2026, 3:30 pm IST");

    expect(b?.quote).toMatchObject({ kind: "refusal", reason: "date_unavailable" });
    expect(b?.reply).toContain("12 Dec 2026");
    expect(b?.reply).toMatch(/not available/i);
    expect(b?.reply).not.toMatch(/₹/);

    expect(r.ticks).toEqual([{ at: "2026-11-09T11:00:00.000Z", processed: 1, expiredHolds: expect.any(Array) }]);
    expect(r.ticks?.[0]?.expiredHolds).toHaveLength(1);

    expect(c?.quote.kind).toBe("quote");
    expect(c?.reply).toContain("held for you until 11 Nov 2026, 5:30 pm IST");
    const { rows } = await db.pool.query("SELECT status, count(*)::int AS n FROM holds GROUP BY status ORDER BY status");
    expect(rows).toEqual([{ status: "active", n: 1 }, { status: "expired", n: 1 }]);
  });

  it("writes a hold ledger entry for the placement and for the expiry, and the chain still verifies", async () => {
    const { rows } = await db.pool.query(
      "SELECT payload->>'action' AS action, thread_id FROM ledger_entries WHERE type='hold' ORDER BY seq",
    );
    expect(rows.map((x) => x.action)).toEqual(["placed", "expired", "placed"]);
    expect(rows[0]?.thread_id).toBe(rows[1]?.thread_id);
  });

  it("the quote reply carries only numbers from the kernel, the date echo and the hold time", async () => {
    const own = await createTestDb();
    const r = await runFixture("fixtures/holds-saturday.json", { pool: own.pool, only: 0 }).finally(() => own.drop());
    const q = r.quote as Quote;
    const found = (r.reply.match(/\d[\d,]*/g) ?? []).map((t) => t.replaceAll(",", ""));
    const allowed = new Set<string>();
    const add = (minor: number) => {
      allowed.add(String(Math.trunc(minor / 100)));
      if (minor % 100) allowed.add(String(Math.abs(minor % 100)));
    };
    add(q.total);
    for (const l of q.lines) {
      add(l.amount);
      for (const n of l.label.match(/\d+/g) ?? []) allowed.add(n);
    }
    // date echo, guests, validUntil, hold time 9 Nov 2026, 3:30 pm
    for (const n of ["12", "2026", "120", "9", "11", "3", "30", String(Number(q.validUntil.slice(8, 10))), String(Number(q.validUntil.slice(5, 7)))]) allowed.add(n);
    expect(found.filter((n) => !allowed.has(String(Number(n))))).toEqual([]);
  });
});
