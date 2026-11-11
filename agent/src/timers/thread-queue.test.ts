/**
 * V9: thread_work_queue's claim/release pair. Mirrors availability.test.ts's "concurrent placeHold calls for
 * one date: exactly one wins" (same Promise.all-over-concurrent-calls-for-one-claim-target template).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { claimThread, releaseThread } from "./thread-queue.js";

let db: TestDb;
const T = "tenant-thread-queue";
let n = 0;

beforeAll(async () => {
  db = await createTestDb();
  await db.pool.query("INSERT INTO tenants (id, name) VALUES ($1,$1)", [T]);
  await db.pool.query("INSERT INTO customers (id, tenant_id, phone_hash) VALUES ($1,$2,'h')", [`${T}-c`, T]);
});
afterAll(async () => {
  await db.drop();
});

async function thread(): Promise<string> {
  const id = `${T}-th-${++n}`;
  await db.pool.query("INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3)", [id, T, `${T}-c`]);
  return id;
}

const NOW = "2026-11-07T10:00:00Z";

describe("claimThread / releaseThread", () => {
  it("concurrent claimThread calls for one thread: exactly one wins", async () => {
    const th = await thread();
    const runIds = ["run-a", "run-b", "run-c"];
    const results = await Promise.all(runIds.map((runId) => claimThread(db.pool, th, runId, NOW)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(2);
    const winner = runIds[results.findIndex((r) => r.ok)];
    const { rows } = await db.pool.query("SELECT claimed_by FROM thread_work_queue WHERE thread_id=$1", [th]);
    expect(rows[0].claimed_by).toBe(winner);
  });

  it("releasing, then claiming again, succeeds", async () => {
    const th = await thread();
    const first = await claimThread(db.pool, th, "run-1", NOW);
    expect(first.ok).toBe(true);
    await releaseThread(db.pool, th, "run-1");
    const second = await claimThread(db.pool, th, "run-2", NOW);
    expect(second.ok).toBe(true);
    const { rows } = await db.pool.query("SELECT claimed_by FROM thread_work_queue WHERE thread_id=$1", [th]);
    expect(rows[0].claimed_by).toBe("run-2");
  });

  it("a release with the wrong runId is a no-op and does not free a claim someone else still holds", async () => {
    const th = await thread();
    const first = await claimThread(db.pool, th, "run-1", NOW);
    expect(first.ok).toBe(true);
    await releaseThread(db.pool, th, "some-other-run");
    const stillClaimed = await claimThread(db.pool, th, "run-2", NOW);
    expect(stillClaimed.ok).toBe(false);
    const { rows } = await db.pool.query("SELECT claimed_by FROM thread_work_queue WHERE thread_id=$1", [th]);
    expect(rows[0].claimed_by).toBe("run-1");
  });
});
