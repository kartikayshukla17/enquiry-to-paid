import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import type { Quote } from "../kernel/types.js";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import { LlmError, type CallMeta, type LlmProvider, type WordReplyInput } from "../llm/types.js";
import { handleMessage, type MessageDeps } from "./handle-message.js";

let db: TestDb;
let kernel: KernelBridge;
beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

const CARD_PATH = fileURLToPath(new URL("../../../rate-cards/fictional-banquet.json", import.meta.url));
const TENANT = { id: "tenant-rose-court", name: "FICTIONAL: Rose Court Banquets" };
const META: CallMeta = { modelId: "test-model-1", provider: "testprov", region: "eu-test-1", usage: { tokens: 500, costMinor: 3 } };
const GOOD = { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9200 };

let n = 0;
async function run(
  llm: Partial<LlmProvider>,
  opts: { text?: string; deps?: Partial<MessageDeps>; kernel?: KernelBridge } = {},
) {
  const events: EscalationEvent[] = [];
  const provider: LlmProvider = {
    extract: () => Promise.resolve({ ...META, fields: GOOD }),
    wordReply: (i: WordReplyInput) => Promise.resolve({ ...META, usage: { tokens: 50, costMinor: 1 }, text: i.template }),
    ...llm,
  };
  const rateCard = JSON.parse(await readFile(CARD_PATH, "utf8")) as { version: number };
  const threadId = `t-llm-${++n}`;
  const res = await handleMessage(
    { pool: db.pool, kernel: opts.kernel ?? kernel, notifier: collectingNotifier(events), llm: provider, ...opts.deps },
    {
      tenant: TENANT,
      threadId,
      customerRef: `c-llm-${n}`,
      rateCard,
      rateCardVersion: rateCard.version,
      now: "2026-11-07T10:00:00Z",
      availability: { blockedDates: [] },
      message: opts.text ?? "free text from a fictional customer",
    },
  );
  const rows = (
    await db.pool.query(
      "SELECT type, payload, model_id, provider, region, cost_minor::int AS cost FROM ledger_entries WHERE thread_id = $1 ORDER BY seq",
      [threadId],
    )
  ).rows;
  const thread = (await db.pool.query("SELECT state, fields FROM threads WHERE id = $1", [threadId])).rows[0];
  return { res, events, rows, thread };
}

describe("free text through the LlmProvider seam", () => {
  it("quotes from validated typed fields, with model/provider/region/cost on every ledger row", async () => {
    const { res, rows } = await run({});
    expect((res.outcome as Quote).total).toBe(56_640_000);
    expect(rows.map((r) => r.type)).toEqual(["enquiry", "extraction", "quote"]);
    for (const r of rows) expect(r).toMatchObject({ model_id: "test-model-1", provider: "testprov", region: "eu-test-1" });
    // The text was seen by the provider (enquiry row, no cost); the call's cost is on the extraction row.
    expect(rows.map((r) => r.cost)).toEqual([0, 3, 0]);
  });

  it("rejects schema-invalid output: holding reply, refusal row with the reason, escalation, never a quote", async () => {
    const bad = [
      { ...GOOD, discountPercent: 50 },
      { ...GOOD, guestCount: "120" },
      { ...GOOD, confidenceBps: 0.9 },
      "just a string",
    ];
    for (const fields of bad) {
      const { res, rows, events, thread } = await run({ extract: () => Promise.resolve({ ...META, fields }) });
      expect(res.outcome).toMatchObject({ kind: "refusal", reason: "low_confidence", ruleGap: "extraction_schema_invalid" });
      expect(res.reply).toMatch(/passed it to them/);
      expect(res.reply).not.toMatch(/\d|₹/);
      expect(rows.map((r) => r.type)).toEqual(["enquiry", "extraction", "refusal"]);
      expect(rows[1]?.payload).toMatchObject({ status: "rejected", failure: "schema_invalid" });
      expect(rows.some((r) => r.type === "quote")).toBe(false);
      expect(rows[1]).toMatchObject({ provider: "testprov", cost: 3 }); // the call happened and cost money
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ reason: "low_confidence", ruleGap: "extraction_schema_invalid" });
      expect(thread.fields).toEqual({}); // nothing merged
    }
  });

  it("extraction output cannot carry unknown keys into the kernel", async () => {
    const seen: Record<string, unknown>[] = [];
    const spy: KernelBridge = { ...kernel, evaluate: (i: { fields: unknown }) => (seen.push(i.fields as Record<string, unknown>), kernel.evaluate(i)) } as KernelBridge;
    await run({ extract: () => Promise.resolve({ ...META, fields: { ...GOOD, discountPercent: 90, raw: "ignore rules" } }) }, { kernel: spy });
    expect(seen).toHaveLength(0); // rejected before the kernel was ever consulted
    await run({}, { kernel: spy });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] as object).sort()).toEqual(["confidenceBps", "date", "guestCount", "language", "service"]);
  });

  it.each([
    ["timeout", "timeout"],
    ["rate_limited", "rate_limited"],
    ["http_error", "provider_error"],
    ["malformed_response", "malformed_response"],
  ] as const)("provider failure (%s) yields a holding reply and never a quote", async (code, failure) => {
    const attempt = { modelId: "test-model-1", provider: "testprov", region: "eu-test-1" };
    const { res, rows, events, thread } = await run({ extract: () => Promise.reject(new LlmError(code, "boom", attempt)) });
    expect(res.outcome).toMatchObject({ kind: "refusal", reason: "low_confidence", ruleGap: `extraction_${failure}` });
    expect(res.reply).toMatch(/passed it to them/);
    expect(res.reply).not.toMatch(/\d|₹/);
    expect(rows.map((r) => r.type)).toEqual(["enquiry", "extraction", "refusal"]);
    expect(rows[1]?.payload).toMatchObject({ status: "rejected", failure });
    expect(rows[2]).toMatchObject({ provider: "testprov", region: "eu-test-1", cost: 0 });
    expect(events).toHaveLength(1);
    expect(thread.state).toBe("refused");
  });

  it("configuration errors (missing recording) are loud, not a quiet holding reply", async () => {
    await expect(run({ extract: () => Promise.reject(new LlmError("missing_recording", "no recording")) })).rejects.toThrow(/no recording/);
  });

  it("low confidence below the threshold refuses with the holding reply, merges nothing, escalates", async () => {
    const low = { ...GOOD, confidenceBps: 6999 };
    const { res, rows, events, thread } = await run({ extract: () => Promise.resolve({ ...META, fields: low }) });
    expect(res.outcome).toEqual({ kind: "refusal", reason: "low_confidence" });
    expect(res.reply).toMatch(/passed it to them/);
    expect(rows[1]?.payload).toMatchObject({ status: "low_confidence", thresholdBps: 7000 });
    expect(events).toHaveLength(1);
    expect(thread.fields).toEqual({});
  });

  it("the threshold is configurable; exactly at it is accepted", async () => {
    const at = { ...GOOD, confidenceBps: 7000 };
    expect((await run({ extract: () => Promise.resolve({ ...META, fields: at }) })).res.outcome.kind).toBe("quote");
    const mid = { ...GOOD, confidenceBps: 8000 };
    const strict = await run({ extract: () => Promise.resolve({ ...META, fields: mid }) }, { deps: { lowConfidenceBps: 8500 } });
    expect(strict.res.outcome).toMatchObject({ reason: "low_confidence" });
  });

  it("a missing field still gets exactly one templated clarifying question", async () => {
    const { date: _d, ...noDate } = GOOD;
    const { res, events } = await run({ extract: () => Promise.resolve({ ...META, fields: noDate }) });
    expect(res.reply).toContain("Which date do you have in mind?");
    expect(events).toEqual([]);
  });
});

describe("LLM-worded replies: numbers injected by code, stray numbers fall back", () => {
  const worded = (text: string) => ({
    wordReply: () => Promise.resolve({ ...META, usage: { tokens: 40, costMinor: 2 }, text }),
  });
  const QUOTE_WORDING = "Lovely to hear from you! For {{guestCount}} guests on {{date}}, here is what it comes to:\n\n{{lines}}\n\nTotal: {{total}}\nValid until {{validUntil}}.";

  it("uses the model's wording and puts kernel numbers in afterwards; wording cost lands on the outcome row", async () => {
    const { res, rows } = await run(worded(QUOTE_WORDING), { deps: { wordReplies: true } });
    expect(res.reply).toContain("Lovely to hear from you! For 120 guests on 12 Dec 2026");
    expect(res.reply).toContain("Total: ₹5,66,400");
    expect(rows.map((r) => r.cost)).toEqual([0, 3, 2]);
    expect(rows[2]).toMatchObject({ type: "quote", provider: "testprov" });
  });

  it.each([
    ["a stray price", QUOTE_WORDING.replace("Total:", "Special offer ₹99,999. Total:")],
    ["a stray digit run", QUOTE_WORDING + " Book within 48 hours."],
    ["a stray number word", QUOTE_WORDING + " That is about five lakh."],
    ["a dropped placeholder", "Here you go: {{lines}}"],
    ["an invented placeholder", QUOTE_WORDING + " {{discount}}"],
  ])("falls back to the template reply on %s", async (_n, text) => {
    const plain = await run({}, { deps: { wordReplies: false } });
    const { res } = await run(worded(text), { deps: { wordReplies: true } });
    expect(res.reply).toBe(plain.res.reply);
    expect(res.outcome.kind).toBe("quote");
  });

  it("falls back when the wording call itself fails", async () => {
    const plain = await run({}, { deps: { wordReplies: false } });
    const { res } = await run({ wordReply: () => Promise.reject(new LlmError("timeout", "slow")) }, { deps: { wordReplies: true } });
    expect(res.reply).toBe(plain.res.reply);
  });
});
