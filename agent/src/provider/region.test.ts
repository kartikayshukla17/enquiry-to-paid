import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectingNotifier } from "../escalation/index.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { createProvider } from "../llm/config.js";
import { createGroqProvider } from "../llm/groq/index.js";
import type { LlmProvider } from "../llm/types.js";
import { runChat } from "../simulator/chat.js";
import { customerTextSeenBy } from "./seen-by.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

// The text has a recording in src/llm/fixtures, so the fixture provider can answer it offline.
const TEXT = "Hi, we are planning my cousin's engagement at your hall on 12 December 2026 for about 120 guests. Please send a quote.";
const TENANT = "tenant-region-test";

// A Groq adapter pointed at a stub endpoint: a real provider object, no network.
const groqStub = (): LlmProvider =>
  createGroqProvider({
    apiKey: "k",
    model: "stub-model",
    region: "eu-west-stub",
    fetch: (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ service: "banquet", date: "2026-12-12", guestCount: 120, locality: null, language: "en", confidenceBps: 9000 }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      )) as typeof fetch,
  });

describe("region logging per call", () => {
  it("every provider's calls record provider + model + region on every ledger row, and a seen-by record exists per distinct provider/region", async () => {
    const runs: { name: string; llm: LlmProvider; provider: string; model: string; region: string }[] = [
      { name: "fixture", llm: createProvider({ LLM_PROVIDER: "fixture" }, { registry: false }), provider: "fixture", model: "recorded-fixture-v1", region: "local" },
      { name: "keyword", llm: createProvider({ LLM_PROVIDER: "keyword" }, { registry: false }), provider: "keyword", model: "keyword-extractor-v0", region: "local" },
      { name: "groq", llm: groqStub(), provider: "groq", model: "stub-model", region: "eu-west-stub" },
    ];
    for (const r of runs) {
      const res = await runChat(TEXT, { pool: db.pool, tenantId: TENANT, customerRef: `region-${r.name}`, llm: r.llm, notifier: collectingNotifier([]), wordReplies: false });
      const rows = (
        await db.pool.query("SELECT type, provider, model_id, region FROM ledger_entries WHERE thread_id = $1 ORDER BY seq", [res.ledgerRow.threadId])
      ).rows;
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const row of rows) expect(row).toMatchObject({ provider: r.provider, model_id: r.model, region: r.region });
    }
    const seen = await customerTextSeenBy(db.pool, TENANT);
    expect(seen).toEqual([
      { provider: "fixture", modelId: "recorded-fixture-v1", region: "local", messages: 1 },
      { provider: "groq", modelId: "stub-model", region: "eu-west-stub", messages: 1 },
      { provider: "keyword", modelId: "keyword-extractor-v0", region: "local", messages: 1 },
    ]);
  });

  it("a provider that fails still shows up as having been aimed at (via the enquiry row), never as 'unknown' when it named itself", async () => {
    const failing = createGroqProvider({
      apiKey: "k",
      model: "down-model",
      region: "ap-south-stub",
      fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    await runChat(TEXT, { pool: db.pool, tenantId: "tenant-region-fail", customerRef: "region-fail", llm: failing, notifier: collectingNotifier([]) });
    expect(await customerTextSeenBy(db.pool, "tenant-region-fail")).toEqual([
      { provider: "groq", modelId: "down-model", region: "ap-south-stub", messages: 1 },
    ]);
  });
});
