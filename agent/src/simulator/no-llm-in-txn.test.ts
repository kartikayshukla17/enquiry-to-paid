import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { collectingNotifier } from "../escalation/index.js";
import { createProvider } from "../llm/config.js";
import type { LlmProvider } from "../llm/types.js";
import { runFixture } from "./run-fixture.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

/** Connections of this test database sitting inside an open transaction right now (seen from a different connection). */
async function openTransactions(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'",
  );
  return Number(r.rows[0]?.n);
}

/** Replay provider whose every call records whether a DB transaction was open while the "network" call ran. */
function watched(pool: Pool): { llm: LlmProvider; calls: { op: string; openTxns: number }[] } {
  const inner = createProvider();
  const calls: { op: string; openTxns: number }[] = [];
  const llm: LlmProvider = {
    async extract(i) {
      calls.push({ op: "extract", openTxns: await openTransactions(pool) });
      return inner.extract(i);
    },
    async wordReply(i) {
      calls.push({ op: "wordReply", openTxns: await openTransactions(pool) });
      return inner.wordReply(i);
    },
  };
  return { llm, calls };
}

describe("no LLM or network call while a DB transaction is open (runFixture seam)", () => {
  it("extraction and reply wording both run with no open transaction, and the wording is still used", async () => {
    const { llm, calls } = watched(db.pool);
    const r = await runFixture("fixtures/llm-banquet-01-quote.json", { pool: db.pool, llm, wordReplies: true, notifier: collectingNotifier([]) });
    expect(calls.map((c) => c.op)).toContain("wordReply"); // the guard is not vacuous
    expect(calls.filter((c) => c.openTxns > 0)).toEqual([]);
    expect(r.reply).toContain("Lovely to hear from you!");
    expect(r.reply).toContain("Total: ₹5,66,400");
  });

  it("keeps the ledger recording provider/model/region/cost of the calls on the rows", async () => {
    const { llm } = watched(db.pool);
    const r = await runFixture("fixtures/llm-banquet-01-quote.json", { pool: db.pool, llm, wordReplies: true, notifier: collectingNotifier([]) });
    const rows = (
      await db.pool.query("SELECT type, provider, model_id, region, cost_minor::int AS cost FROM ledger_entries WHERE thread_id = $1 ORDER BY seq", [
        r.ledgerRow.threadId,
      ])
    ).rows;
    expect(rows.at(-1)).toMatchObject({ provider: "fixture", model_id: "recorded-fixture-v1", region: "local", cost: 0 });
  });
});
