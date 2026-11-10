import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { hashVisitorIp, recordFeedback, DAILY_MESSAGE_CAP, checkAndBumpUsage } from "./playground.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe("hashVisitorIp", () => {
  it("never returns the raw address, and is stable for the same address+key but differs across keys", () => {
    const a = hashVisitorIp("203.0.113.7", "key-one");
    expect(a).not.toContain("203.0.113.7");
    expect(hashVisitorIp("203.0.113.7", "key-one")).toBe(a);
    expect(hashVisitorIp("203.0.113.7", "key-two")).not.toBe(a);
    expect(hashVisitorIp("203.0.113.8", "key-one")).not.toBe(a);
  });
});

describe("recordFeedback", () => {
  it("stores a rating and an optional comment, scoped to a card", async () => {
    await recordFeedback(db.pool, { card: "rate-cards/fictional-photographer.json", rating: "up", comment: "loved it", now: "2026-11-11T10:00:00Z" });
    const r = await db.pool.query("SELECT card, rating, comment FROM playground_feedback");
    expect(r.rows).toEqual([{ card: "rate-cards/fictional-photographer.json", rating: "up", comment: "loved it" }]);
  });

  it("rejects a rating outside up/down and a comment over 1000 characters", async () => {
    await expect(recordFeedback(db.pool, { card: "x", rating: "meh" as never, now: "2026-11-11T10:00:00Z" })).rejects.toThrow();
    await expect(recordFeedback(db.pool, { card: "x", rating: "up", comment: "a".repeat(1001), now: "2026-11-11T10:00:00Z" })).rejects.toThrow();
  });

  it("an absent comment is stored as null, not a crash", async () => {
    await recordFeedback(db.pool, { card: "rate-cards/fictional-banquet.json", rating: "down", now: "2026-11-11T10:00:00Z" });
    const r = await db.pool.query("SELECT comment FROM playground_feedback WHERE card='rate-cards/fictional-banquet.json'");
    expect(r.rows[0].comment).toBeNull();
  });
});

describe("checkAndBumpUsage", () => {
  const ip = "ip-under-test-" + Math.random().toString(36).slice(2);

  it("allows messages up to the daily cap, then refuses, without going over on the refusing call", async () => {
    for (let i = 0; i < DAILY_MESSAGE_CAP; i++) {
      expect(await checkAndBumpUsage(db.pool, ip, "2026-11-11")).toEqual({ ok: true });
    }
    expect(await checkAndBumpUsage(db.pool, ip, "2026-11-11")).toEqual({ ok: false, reason: "daily_cap" });
    const row = await db.pool.query("SELECT count FROM playground_usage WHERE ip_hash=$1 AND day='2026-11-11'", [ip]);
    expect(row.rows[0].count).toBe(DAILY_MESSAGE_CAP);
  });

  it("a new day resets the cap for the same visitor", async () => {
    for (let i = 0; i < DAILY_MESSAGE_CAP; i++) expect(await checkAndBumpUsage(db.pool, ip, "2026-11-12")).toEqual({ ok: true });
    expect(await checkAndBumpUsage(db.pool, ip, "2026-11-12")).toEqual({ ok: false, reason: "daily_cap" });
  });

  it("concurrent calls at the boundary never let the count exceed the cap", async () => {
    const ip2 = "concurrent-" + Math.random().toString(36).slice(2);
    const results = await Promise.all(Array.from({ length: DAILY_MESSAGE_CAP + 10 }, () => checkAndBumpUsage(db.pool, ip2, "2026-11-13")));
    expect(results.filter((r) => r.ok)).toHaveLength(DAILY_MESSAGE_CAP);
    const row = await db.pool.query("SELECT count FROM playground_usage WHERE ip_hash=$1 AND day='2026-11-13'", [ip2]);
    expect(row.rows[0].count).toBe(DAILY_MESSAGE_CAP);
  });
});
