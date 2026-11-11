import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { checkAndBumpGroqUsage } from "./groq-ceiling.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe("checkAndBumpGroqUsage", () => {
  it("allows calls up to the ceiling, then refuses, without going over on the refusing call", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await checkAndBumpGroqUsage(db.pool, "2026-11-11", 3)).toEqual({ ok: true });
    }
    expect(await checkAndBumpGroqUsage(db.pool, "2026-11-11", 3)).toEqual({ ok: false, reason: "ceiling_reached" });
    const row = await db.pool.query("SELECT count FROM groq_daily_usage WHERE day='2026-11-11'");
    expect(row.rows[0].count).toBe(3);
  });

  it("a new day resets the ceiling (global, not per-tenant/visitor)", async () => {
    for (let i = 0; i < 3; i++) expect(await checkAndBumpGroqUsage(db.pool, "2026-11-12", 3)).toEqual({ ok: true });
    expect(await checkAndBumpGroqUsage(db.pool, "2026-11-12", 3)).toEqual({ ok: false, reason: "ceiling_reached" });
  });

  it("concurrent calls at the boundary never let the count exceed the ceiling", async () => {
    const results = await Promise.all(Array.from({ length: 13 }, () => checkAndBumpGroqUsage(db.pool, "2026-11-13", 3)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const row = await db.pool.query("SELECT count FROM groq_daily_usage WHERE day='2026-11-13'");
    expect(row.rows[0].count).toBe(3);
  });
});
