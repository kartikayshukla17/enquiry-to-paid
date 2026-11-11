import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { createProvider } from "./config.js";
import { LlmError, type ExtractResult, type LlmProvider, type WordReplyResult } from "./types.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const META = { modelId: "test-model", provider: "testprov", region: "us-test", usage: { tokens: 10 } };

function stubProvider(): LlmProvider & { calls: number } {
  return {
    calls: 0,
    async extract(): Promise<ExtractResult> {
      this.calls++;
      return { ...META, fields: { ok: true } };
    },
    async wordReply(): Promise<WordReplyResult> {
      this.calls++;
      return { ...META, text: "worded" };
    },
  };
}

describe("createProvider wires the global Groq ceiling only for a real, live Groq provider", () => {
  it("wraps a real groq/live provider when a pool is given, honoring GROQ_DAILY_CEILING", async () => {
    const stub = stubProvider();
    const llm = createProvider(
      { LLM_PROVIDER: "groq", LLM_MODE: "live", GROQ_API_KEY: "k", GROQ_DAILY_CEILING: "1" },
      { registry: false, liveProvider: stub, pool: db.pool },
    );
    await llm.extract({ text: "x", schemaVersion: "extract-v1" });
    expect(stub.calls).toBe(1);
    const err = await llm.extract({ text: "y", schemaVersion: "extract-v1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe("rate_limited");
    expect(stub.calls).toBe(1); // the underlying stub was never called on the refusing call
  });

  it("leaves fixture/keyword providers and replay mode unaffected even when a pool is passed", async () => {
    const before = (await db.pool.query("SELECT count(*)::int AS n FROM groq_daily_usage")).rows[0].n;

    // None of these have a matching recording for this exact text/schemaVersion; that's fine — we only care
    // whether createProvider ever reaches the database for them, not whether the call itself succeeds.
    const fixture = createProvider({ LLM_PROVIDER: "fixture" }, { pool: db.pool, registry: false });
    await fixture.extract({ text: "x", schemaVersion: "extract-v1" }).catch(() => undefined);

    const keyword = createProvider({ LLM_PROVIDER: "keyword" }, { pool: db.pool, registry: false });
    await keyword.extract({ text: "x", schemaVersion: "extract-v1" }).catch(() => undefined);

    const replayGroq = createProvider({ LLM_PROVIDER: "groq" }, { pool: db.pool, registry: false }); // default LLM_MODE=replay
    await replayGroq.extract({ text: "x", schemaVersion: "extract-v1" }).catch(() => undefined);

    const after = (await db.pool.query("SELECT count(*)::int AS n FROM groq_daily_usage")).rows[0].n;
    expect(after).toBe(before); // no new row/increment: none of these ever reach checkAndBumpGroqUsage
  });

  it("without a pool, behavior is unchanged (no DB access, no throw) for a live groq provider", async () => {
    const stub = stubProvider();
    const llm = createProvider({ LLM_PROVIDER: "groq", LLM_MODE: "live", GROQ_API_KEY: "k" }, { registry: false, liveProvider: stub });
    await llm.extract({ text: "x", schemaVersion: "extract-v1" });
    await llm.extract({ text: "y", schemaVersion: "extract-v1" });
    expect(stub.calls).toBe(2);
  });
});
