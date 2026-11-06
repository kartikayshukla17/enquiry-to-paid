import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import type { Quote } from "../kernel/types.js";
import { createProvider } from "../llm/config.js";
import { runFixture } from "./run-fixture.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

// Replay is the default: these runs make no network call and read only src/llm/fixtures.
const run = (fx: string, extra: { wordReplies?: boolean } = {}) => {
  const events: EscalationEvent[] = [];
  return runFixture(`fixtures/${fx}.json`, { pool: db.pool, notifier: collectingNotifier(events), ...extra }).then((r) => ({ r, events }));
};
const types = async (threadId: string) =>
  (await db.pool.query("SELECT type, provider, model_id, region, cost_minor::int AS cost FROM ledger_entries WHERE thread_id = $1 ORDER BY seq", [threadId])).rows;

describe("pnpm sim run on free-text fixtures (offline replay)", () => {
  it("quote: free text becomes a kernel quote identical to the typed-fixture one", async () => {
    const { r, events } = await run("llm-banquet-01-quote");
    expect((r.quote as Quote).total).toBe(56_640_000);
    expect(r.reply).toContain("₹5,66,400");
    expect(events).toEqual([]);
    const rows = await types(r.ledgerRow.threadId as string);
    expect(rows.map((x) => x.type)).toEqual(["enquiry", "extraction", "quote"]);
    expect(rows.every((x) => x.provider === "fixture" && x.region === "local" && x.cost === 0)).toBe(true);
  });

  it("quote on a weekday uses the weekday rule", async () => {
    const { r } = await run("llm-banquet-02-weekday-quote");
    const q = r.quote as Quote;
    expect(q.kind).toBe("quote");
    expect(q.lines.map((l) => l.label)).toContain("Hall hire (Mon-Thu)");
  });

  it("missing field: exactly one templated clarifying question", async () => {
    const { r, events } = await run("llm-banquet-03-missing-date");
    expect(r.reply).toContain("Which date do you have in mind?");
    expect(r.reply.match(/\?/g)).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("low confidence: holding reply, refusal low_confidence, escalation, no quote", async () => {
    const { r, events } = await run("llm-banquet-04-low-confidence");
    expect(r.quote).toEqual({ kind: "refusal", reason: "low_confidence" });
    expect(r.reply).not.toMatch(/\d|₹/);
    expect(events).toHaveLength(1);
  });

  it.each(["llm-banquet-05-schema-invalid", "llm-banquet-07-wrong-types"])("%s: rejected, holding reply, no quote", async (fx) => {
    const { r, events } = await run(fx);
    expect(r.quote).toMatchObject({ kind: "refusal", reason: "low_confidence", ruleGap: "extraction_schema_invalid" });
    expect(r.reply).not.toMatch(/\d|₹/);
    expect(events).toHaveLength(1);
    const rows = await types(r.ledgerRow.threadId as string);
    expect(rows.some((x) => x.type === "quote")).toBe(false);
  });

  it("prompt injection in the customer text does not change the price", async () => {
    const { r } = await run("llm-banquet-06-injection");
    const q = r.quote as Quote;
    expect(q.kind).toBe("quote");
    expect(r.reply).not.toContain("₹1\n");
    expect(q.total).toBeGreaterThan(10_000_000);
  });

  it("recorded LLM wording is used and the numbers still come from the kernel", async () => {
    const { r } = await run("llm-banquet-01-quote", { wordReplies: true });
    expect(r.reply).toContain("Lovely to hear from you!");
    expect(r.reply).toContain("Total: ₹5,66,400");
  });

  it("a text with no recording fails loudly in replay mode", async () => {
    const provider = createProvider({ LLM_PROVIDER: "fixture", LLM_MODE: "replay" }, { recordingsDir: "/nonexistent-recordings" });
    await expect(runFixture("fixtures/llm-banquet-01-quote.json", { pool: db.pool, llm: provider, notifier: collectingNotifier([]) })).rejects.toThrow(
      /no recording/,
    );
  });
});
