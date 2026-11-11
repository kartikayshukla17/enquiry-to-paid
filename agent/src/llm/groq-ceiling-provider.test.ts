import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { withGroqDailyCeiling } from "./groq-ceiling.js";
import { LlmError, type ExtractResult, type LlmProvider, type WordReplyResult } from "./types.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const META = { modelId: "test-model", provider: "testprov", region: "us-test", usage: { tokens: 10 } };

/** A plain test double implementing LlmProvider directly (no network, no fixture machinery) — counts calls. */
function stubProvider(): LlmProvider & { extractCalls: number; wordReplyCalls: number } {
  return {
    extractCalls: 0,
    wordReplyCalls: 0,
    async extract(): Promise<ExtractResult> {
      this.extractCalls++;
      return { ...META, fields: { ok: true } };
    },
    async wordReply(): Promise<WordReplyResult> {
      this.wordReplyCalls++;
      return { ...META, text: "worded" };
    },
  };
}

describe("withGroqDailyCeiling", () => {
  it("passes the first N calls through and increments the counter, then refuses the N+1th without calling the underlying provider", async () => {
    const day = "2026-11-14";
    const stub = stubProvider();
    const wrapped = withGroqDailyCeiling(stub, db.pool, { ceiling: 2, now: () => new Date(`${day}T10:00:00Z`) });

    await wrapped.extract({ text: "x", schemaVersion: "extract-v1" });
    await wrapped.extract({ text: "y", schemaVersion: "extract-v1" });
    expect(stub.extractCalls).toBe(2);

    const err = await wrapped.extract({ text: "z", schemaVersion: "extract-v1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe("rate_limited");
    expect(stub.extractCalls).toBe(2); // the underlying provider was never called on the refusing call

    const row = await db.pool.query("SELECT count FROM groq_daily_usage WHERE day=$1", [day]);
    expect(row.rows[0].count).toBe(2);
  });

  it("extract and wordReply share the same ceiling (both are real Groq calls against the same quota)", async () => {
    const day = "2026-11-15";
    const stub = stubProvider();
    const wrapped = withGroqDailyCeiling(stub, db.pool, { ceiling: 2, now: () => new Date(`${day}T10:00:00Z`) });

    await wrapped.extract({ text: "x", schemaVersion: "extract-v1" });
    await wrapped.wordReply({ kind: "quote", template: "t" });
    expect(stub.extractCalls).toBe(1);
    expect(stub.wordReplyCalls).toBe(1);

    const err = await wrapped.wordReply({ kind: "quote", template: "t" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe("rate_limited");
    expect(stub.wordReplyCalls).toBe(1);
  });

  it("concurrent calls at the boundary never call the underlying provider more than the ceiling allows", async () => {
    const day = "2026-11-16";
    const stub = stubProvider();
    const wrapped = withGroqDailyCeiling(stub, db.pool, { ceiling: 3, now: () => new Date(`${day}T10:00:00Z`) });

    const results = await Promise.all(
      Array.from({ length: 13 }, () => wrapped.extract({ text: "x", schemaVersion: "extract-v1" }).then(() => "ok" as const, () => "refused" as const)),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(stub.extractCalls).toBe(3);
  });
});
