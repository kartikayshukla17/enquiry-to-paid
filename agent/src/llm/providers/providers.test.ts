import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectingNotifier } from "../../escalation/index.js";
import { extractFields } from "../../extract/extract.js";
import { createTestDb, type TestDb } from "../../ledger/test-db.js";
import { runChat } from "../../simulator/chat.js";
import { createProvider } from "../config.js";
import { withWeakHinglishNumbers } from "./weak.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const ENQUIRY = "Hi, we are planning my cousin's engagement at your hall on 12 December 2026 for about 120 guests. Please send a quote.";
const PROVIDERS = [
  { env: { LLM_PROVIDER: "fixture", LLM_MODEL: "recorded-fixture-v1" }, model: "recorded-fixture-v1", provider: "fixture" },
  { env: { LLM_PROVIDER: "keyword", LLM_MODEL: "keyword-extractor-v0" }, model: "keyword-extractor-v0", provider: "keyword" },
];

describe("swapping provider is configuration only", () => {
  it.each(PROVIDERS)("the same pipeline test passes under $provider/$model, with no pipeline change", async ({ env, model, provider }) => {
    const llm = createProvider(env, { registry: false });
    const r = await runChat(ENQUIRY, { pool: db.pool, llm, notifier: collectingNotifier([]), customerRef: `swap-${provider}` });
    expect(r.reply).toContain("₹5,66,400");
    expect(r.ledgerRow.type).toBe("quote");
    const rows = (
      await db.pool.query("SELECT type, provider, model_id, region FROM ledger_entries WHERE thread_id = $1 ORDER BY seq", [r.ledgerRow.threadId])
    ).rows;
    expect(rows.map((x) => x.type)).toEqual(["enquiry", "extraction", "quote"]);
    for (const row of rows) expect(row).toMatchObject({ provider, model_id: model, region: "local" });
  });
});

describe("keyword-extractor-v0 (rule-based, offline, region local)", () => {
  const kw = () => createProvider({ LLM_PROVIDER: "keyword" }, { registry: false });
  const get = async (text: string) => {
    const e = await extractFields(kw(), text);
    if (!e.ok) throw new Error(e.detail);
    return e.fields;
  };

  it("reads English and Hinglish counts and dates", async () => {
    expect(await get("Banquet on 5 Dec 2026 for 80 guests")).toMatchObject({ service: "banquet", date: "2026-12-05", guestCount: 80, language: "en" });
    expect(await get("Do sau log ke liye banquet chahiye 19 December 2026 ko, sagai hai.")).toMatchObject({
      date: "2026-12-19",
      guestCount: 200,
      language: "hinglish",
    });
    expect(await get("dedh sau log, 12 December 2026 ko shaadi hai")).toMatchObject({ guestCount: 150 });
  });

  it("leaves a date without a year null rather than guessing, and flags discount and bot questions", async () => {
    expect((await get("hall for 50 guests on 12 Dec")).date ?? null).toBeNull();
    expect((await get("can you give a discount? 50 guests 12 December 2026")).intent).toBe("discount_request");
    expect((await get("are you a bot?")).intent).toBe("asks_if_bot");
  });

  it("never quotes a discount demand", async () => {
    const r = await runChat("please give 20% discount, banquet for 100 guests on 12 December 2026", {
      pool: db.pool,
      llm: kw(),
      notifier: collectingNotifier([]),
      customerRef: "kw-discount",
    });
    expect(r.ledgerRow.type).not.toBe("quote");
  });
});

describe("weak-fixture-v0 (deliberately misreads Hinglish numbers)", () => {
  it("is labelled as its own model, leaves English alone and misreads Hinglish counts", async () => {
    const llm = createProvider({ LLM_PROVIDER: "fixture", LLM_MODEL: "weak-fixture-v0" }, { registry: false });
    const en = await llm.extract({ text: ENQUIRY, schemaVersion: "extract-v2" });
    expect(en).toMatchObject({ modelId: "weak-fixture-v0", provider: "fixture", region: "local" });
    expect((en.fields as { guestCount: number }).guestCount).toBe(120);
  });
});

describe("weak-fixture-v0 on Hinglish", () => {
  it("drops the 'sau' from code-switched hundreds", async () => {
    const stub = {
      extract: async () => ({
        modelId: "m", provider: "fixture", region: "local", usage: { tokens: 0 },
        fields: { service: "banquet", date: null, guestCount: 200, locality: null, language: "hinglish", confidenceBps: 9000 },
      }),
      wordReply: async () => ({ modelId: "m", provider: "fixture", region: "local", usage: { tokens: 0 }, text: "x" }),
    };
    const r = await withWeakHinglishNumbers(stub).extract({ text: "do sau log", schemaVersion: "extract-v2" });
    expect((r.fields as { guestCount: number }).guestCount).toBe(2);
    expect(r.modelId).toBe("weak-fixture-v0");
  });
});

describe("runtime guard: only enabled provider/model pairs load", () => {
  it("throws for a provider/model that is not in the registry, naming the command to enable it", () => {
    expect(() => createProvider({ LLM_PROVIDER: "keyword" })).toThrow(/keyword\/keyword-extractor-v0 is not enabled.*pnpm provider enable keyword keyword-extractor-v0/);
    expect(() => createProvider({ LLM_PROVIDER: "fixture", LLM_MODEL: "weak-fixture-v0" })).toThrow(/not enabled/);
    expect(() => createProvider({ LLM_PROVIDER: "groq", LLM_MODE: "live", GROQ_API_KEY: "k" })).toThrow(/groq\/llama-3.3-70b-versatile is not enabled/);
  });

  it("loads the committed enabled model, and any model listed in an explicit registry", () => {
    expect(() => createProvider({})).not.toThrow();
    const registry = { current: "keyword/keyword-extractor-v0", enabled: { "keyword/keyword-extractor-v0": { provider: "keyword", model: "keyword-extractor-v0", promptHash8: "", baseline: "", enabledAt: "" } } };
    expect(() => createProvider({ LLM_PROVIDER: "keyword" }, { registry })).not.toThrow();
  });
});

describe("the provider never decides the price", () => {
  it("prices identically under the fixture and keyword providers", async () => {
    const q = async (provider: string) =>
      (
        await runChat(ENQUIRY, {
          pool: db.pool,
          llm: createProvider({ LLM_PROVIDER: provider }, { registry: false }),
          notifier: collectingNotifier([]),
          customerRef: `same-${provider}`,
        })
      ).reply;
    expect(await q("keyword")).toEqual(await q("fixture"));
  });
});
