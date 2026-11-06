import { describe, expect, it } from "vitest";
import { loadKernel } from "../kernel/index.js";
import type { Outcome } from "../kernel/types.js";
import { validateExtraction } from "../extract/schema.js";
import { EVAL_NOW, cardOf, loadRateCard, loadSets, outcomeClass } from "./sets.js";

describe("labelled eval sets", () => {
  it("has 30+ fictional enquiries with at least 12 English, 12 Latin-script Hinglish and some Devanagari", async () => {
    const { cases } = await loadSets();
    const n = (l: string) => cases.filter((c) => c.lang === l).length;
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(n("en")).toBeGreaterThanOrEqual(12);
    expect(n("hinglish")).toBeGreaterThanOrEqual(12);
    expect(n("hi")).toBeGreaterThanOrEqual(2);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.text)).size).toBe(cases.length);
  });

  it("every gold field set is itself valid under the extraction schema", async () => {
    const { cases } = await loadSets();
    for (const c of cases) {
      expect(validateExtraction({ ...c.gold, confidenceBps: 10000 }).ok, c.id).toBe(true);
    }
  });

  it("every gold outcome is exactly what the kernel says for the gold fields (labels are not guesses)", async () => {
    const { cases } = await loadSets();
    const kernel = await loadKernel();
    for (const c of cases) {
      const card = await loadRateCard(cardOf(c));
      const fields = Object.fromEntries(Object.entries(c.gold).filter(([, v]) => v !== null));
      const out = kernel.evaluate({
        rateCard: card,
        fields: { ...fields, confidenceBps: 10000 },
        availability: { blockedDates: c.blockedDates ?? [] },
        now: EVAL_NOW,
      }) as Outcome;
      const got = outcomeClass(out);
      expect(got.kind, c.id).toBe(c.outcome.kind);
      expect(got.reason, c.id).toBe((c.outcome as { reason?: string }).reason);
    }
  });

  it("labels at least 8 photographer enquiries, English and Hinglish, with quote, clarify and refuse outcomes", async () => {
    const { cases } = await loadSets();
    const ph = cases.filter((c) => cardOf(c) === "fictional-photographer");
    expect(ph.length).toBeGreaterThanOrEqual(8);
    expect(ph.filter((c) => c.lang === "en").length).toBeGreaterThanOrEqual(4);
    expect(ph.filter((c) => c.lang === "hinglish").length).toBeGreaterThanOrEqual(4);
    expect(new Set(ph.map((c) => c.outcome.kind))).toEqual(new Set(["quote", "clarify", "refuse"]));
    expect(ph.some((c) => c.outcome.kind === "refuse" && c.outcome.reason === "no_covering_rule")).toBe(true);
  });

  it("labels 12+ contractor enquiries, English and Hinglish, where the majority are gold refusals with no covering rule", async () => {
    const { cases } = await loadSets();
    const ct = cases.filter((c) => cardOf(c) === "fictional-contractor");
    expect(ct.length).toBeGreaterThanOrEqual(12);
    expect(new Set(ct.map((c) => c.lang))).toEqual(new Set(["en", "hinglish"]));
    const refusals = ct.filter((c) => c.outcome.kind === "refuse" && c.outcome.reason === "no_covering_rule");
    expect(refusals.length * 2).toBeGreaterThan(ct.length);
    expect(ct.some((c) => c.outcome.kind === "quote")).toBe(true);
  });

  it("covers all five cards: banquet, seasonal banquet, photographer, B2B supplier and contractor", async () => {
    const { cases } = await loadSets();
    expect([...new Set(cases.map(cardOf))].sort()).toEqual(
      ["fictional-b2b-supplier", "fictional-banquet", "fictional-banquet-seasonal", "fictional-contractor", "fictional-photographer"],
    );
  });

  it("includes deliberately hard cases (ambiguous dates, code-switched numbers)", async () => {
    const { cases } = await loadSets();
    const text = cases.map((c) => c.text).join("\n");
    expect(text).toMatch(/do sau log/i);
    expect(text).toMatch(/Shaadi 12 Dec ko/);
    expect(text).toMatch(/Agle hafte/);
  });
});
