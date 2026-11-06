import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { PROVENANCE_LABEL, runEval, type EvalReport } from "./run-eval.js";
import { loadSets, scoredFields } from "./sets.js";

let db: TestDb;
let report: EvalReport;
let scoredByLang: Record<string, number>;
beforeAll(async () => {
  db = await createTestDb();
  report = await runEval({ pool: db.pool });
  scoredByLang = {};
  for (const c of (await loadSets()).cases) scoredByLang[c.lang] = (scoredByLang[c.lang] ?? 0) + scoredFields(c).length;
});
afterAll(async () => {
  await db.drop();
});

describe("runEval (the function behind `pnpm eval`)", () => {
  it("labels every result as fictional data from a recorded-fixture provider, never as model accuracy", () => {
    expect(PROVENANCE_LABEL).toBe("measured on fictional data; recorded-fixture provider, not a live model");
    expect(report.provenance.label).toBe(PROVENANCE_LABEL);
    expect(report.provenance.modelId).toBe("recorded-fixture-v1");
    expect(report.provenance.provider).toBe("fixture");
    expect(report.provenance.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports extraction and pipeline metrics per language, with counts that add up", () => {
    expect(Object.keys(report.languages)).toEqual(["en", "hinglish", "hi"]);
    let total = 0;
    for (const [lang, m] of Object.entries(report.languages)) {
      expect(m.extraction.fieldsTotal, lang).toBe(scoredByLang[lang]);
      expect(m.cases).toBeGreaterThan(0);
      expect(m.extraction.fieldsCorrect).toBeLessThanOrEqual(m.extraction.fieldsTotal);
      expect(m.extraction.schemaValid).toBeLessThanOrEqual(m.cases);
      expect(m.pipeline.outcomeCorrect).toBeLessThanOrEqual(m.cases);
      total += m.cases;
    }
    expect(report.overall.cases).toBe(total);
    expect(report.cases).toHaveLength(total);
    expect(report.languages.en.cases).toBeGreaterThanOrEqual(12);
    expect(report.languages.hinglish.cases).toBeGreaterThanOrEqual(12);
  });

  it("is not trivially perfect: deliberate recorded mistakes show up as bad numbers", () => {
    for (const lang of ["en", "hinglish"] as const) {
      const m = report.languages[lang];
      expect(m.extraction.fieldsCorrect, lang).toBeLessThan(m.extraction.fieldsTotal);
      expect(m.extraction.schemaValid, lang).toBeLessThan(m.cases);
      expect(m.pipeline.outcomeCorrect, lang).toBeLessThan(m.cases);
    }
  });

  it("counts quotes issued where gold says clarify or refuse, naming the cases", () => {
    const unsafeFromCases = (lang: string) => report.cases.filter((c) => c.lang === lang && c.unsafe).map((c) => c.id);
    // en-09: model invents a date for "next Friday"; hg-04: invents one for "agle hafte Saturday"
    expect(report.languages.en.pipeline.unsafeCaseIds).toContain("en-09");
    expect(report.languages.hinglish.pipeline.unsafeCaseIds).toContain("hg-04");
    for (const lang of ["en", "hinglish", "hi"] as const) {
      expect(report.languages[lang].pipeline.unsafeQuotes).toBe(unsafeFromCases(lang).length);
      expect(report.languages[lang].pipeline.unsafeCaseIds).toEqual(unsafeFromCases(lang));
    }
    expect(report.overall.pipeline.unsafeQuotes).toBe(report.cases.filter((c) => c.unsafe).length);
    // an unsafe case really did issue a quote against a non-quote gold
    for (const c of report.cases.filter((x) => x.unsafe)) {
      expect(c.got).toBe("quote");
      expect(c.gold).not.toBe("quote");
    }
  });

  it("separates safe misses from unsafe quotes: schema-invalid and low-confidence reads never become quotes", () => {
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c]));
    expect(byId["en-16"]).toMatchObject({ schemaValid: false, got: "refuse:low_confidence", unsafe: false });
    expect(byId["hg-12"]).toMatchObject({ schemaValid: false, got: "refuse:low_confidence", unsafe: false });
    expect(byId["en-10"]).toMatchObject({ schemaValid: true, got: "refuse:low_confidence", gold: "clarify", outcomeOk: false, unsafe: false });
  });

  it("flags a quote with the wrong price (wrong year/guest count extracted) separately", () => {
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c]));
    expect(byId["en-02"]?.got).toBe("quote");
    expect(byId["en-02"]?.wrongPrice).toBe(true);
    expect(byId["en-01"]?.wrongPrice).toBe(false);
    expect(report.languages.en.pipeline.wrongPriceCaseIds).toContain("en-02");
  });

  it("a misread date that lands in the past is refused by the kernel, not quoted (hg-16 was a wrong-price quote before)", () => {
    const hg16 = report.cases.find((c) => c.id === "hg-16");
    expect(hg16?.got).toBe("refuse:out_of_policy");
    expect(hg16?.wrongPrice).toBe(false);
    expect(hg16?.unsafe).toBe(false);
  });

  it("scores integers only (basis points), never floats", () => {
    for (const m of [...Object.values(report.languages), report.overall]) {
      for (const v of [m.extraction.fieldAccuracyBps, m.extraction.schemaValidBps, m.extraction.meanConfidenceBps, m.pipeline.outcomeAccuracyBps]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  describe("per rate card (the card dimension)", () => {
    it("reports one engine over every card that has labelled cases, in a fixed order", () => {
      expect(Object.keys(report.cards)).toEqual(["fictional-banquet", "fictional-banquet-seasonal", "fictional-photographer", "fictional-b2b-supplier", "fictional-contractor"]);
      expect(report.provenance.rateCards.map((c) => c.id)).toEqual(Object.keys(report.cards));
      for (const c of report.provenance.rateCards) expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.values(report.cards).reduce((n, c) => n + c.cases, 0)).toBe(report.overall.cases);
    });

    it("splits quotes, refusals and clarifications so they add up to the card's cases", () => {
      for (const [id, c] of Object.entries(report.cases.reduce<Record<string, typeof report.cases>>((a, x) => ({ ...a, [x.card]: [...(a[x.card] ?? []), x] }), {}))) {
        const m = report.cards[id]!;
        expect(m.cases, id).toBe(c.length);
        expect(m.quotes + m.refusals + m.clarifications, id).toBe(m.cases);
        expect(m.refusalShareBps, id).toBe(Math.round((m.refusals * 10_000) / m.cases));
      }
    });

    it("prices photographer enquiries through the same pipeline, in English and Hinglish, with its own bad numbers", () => {
      const ph = report.cases.filter((c) => c.card === "fictional-photographer");
      expect(ph.length).toBeGreaterThanOrEqual(8);
      expect(new Set(ph.map((c) => c.lang))).toEqual(new Set(["en", "hinglish"]));
      const m = report.cards["fictional-photographer"]!;
      expect(m.quotes).toBeGreaterThan(0);
      expect(m.pipeline.wrongPriceCaseIds).toEqual(["ph-en-07", "ph-hg-06"]);
      expect(m.extraction.perFieldTotal.package).toBeGreaterThan(0);
      expect(m.extraction.perFieldTotal.guestCount).toBe(0);
    });

    it("prices B2B supplier enquiries on the same engine: MOQ refusal, MOQ re-quote and tier boundaries in the cases", () => {
      const b2b = report.cases.filter((c) => c.card === "fictional-b2b-supplier");
      expect(b2b.length).toBeGreaterThanOrEqual(8);
      expect(new Set(b2b.map((c) => c.lang))).toEqual(new Set(["en", "hinglish"]));
      const byId = Object.fromEntries(b2b.map((c) => [c.id, c]));
      expect(byId["b2b-en-04"]).toMatchObject({ gold: "refuse:out_of_policy", got: "refuse:out_of_policy", outcomeOk: true });
      expect(byId["b2b-en-05"]).toMatchObject({ gold: "quote", got: "quote", wrongPrice: false });
      expect(byId["b2b-en-08"]).toMatchObject({ got: "quote", wrongPrice: true });
      expect(byId["b2b-hg-07"]).toMatchObject({ got: "quote", wrongPrice: false, wrongFields: ["quantity"] });
    });

    it("never quotes where the labels say no rule covers the case (any card)", () => {
      for (const [id, m] of Object.entries(report.cards)) {
        expect(m.outOfCoverageQuotes, id).toBe(0);
        expect(m.outOfCoverageCaseIds, id).toEqual([]);
      }
    });
  });

  // PRD section 2, Generality: "one engine prices all three fictional rate cards (banquet, photographer, B2B supplier)
  // and mostly refuses on the fourth (contractor)". The same kernel and pipeline read every card; only the card differs.
  describe("generality metric", () => {
    const priced = ["fictional-banquet", "fictional-banquet-seasonal", "fictional-photographer", "fictional-b2b-supplier"];

    it("prices the banquet (plus seasonal), photographer and B2B cards: each refuses under half of its cases", () => {
      for (const id of priced) {
        const m = report.cards[id]!;
        expect(m.quotes, id).toBeGreaterThan(0);
        expect(m.refusalShareBps, id).toBeLessThan(5000);
        expect(m.goldRefusalShareBps, id).toBeLessThan(5000);
      }
    });

    it("mostly refuses on the contractor card, by the labels and in what the pipeline produced", () => {
      const m = report.cards["fictional-contractor"]!;
      expect(m.cases).toBeGreaterThanOrEqual(12);
      expect(m.goldRefusalShareBps).toBeGreaterThan(5000);
      expect(m.refusalShareBps).toBeGreaterThan(5000);
      expect(m.refusals).toBeGreaterThan(m.quotes + m.clarifications);
      expect(m.quotes).toBeGreaterThan(0); // it still prices the narrow cases it covers
    });

    it("issues zero out-of-coverage quotes on every card, and none of the contractor's refusals is a quote in disguise", () => {
      for (const [id, m] of Object.entries(report.cards)) expect(m.outOfCoverageQuotes, id).toBe(0);
      const refused = report.cases.filter((c) => c.card === "fictional-contractor" && c.gold === "refuse:no_covering_rule");
      expect(refused.length).toBeGreaterThanOrEqual(8);
      for (const c of refused) expect(c.got, c.id).not.toBe("quote");
    });

    it("reports the refusal share per card as integer basis points", () => {
      for (const [id, m] of Object.entries(report.cards)) {
        expect(Number.isInteger(m.refusalShareBps), id).toBe(true);
        expect(m.refusalShareBps, id).toBe(Math.round((m.refusals * 10_000) / m.cases));
      }
    });

    it("every no-covering-rule refusal on a card that names a next step escalated with that suggestion; other cards carry none", () => {
      const ct = report.cards["fictional-contractor"]!;
      const noCover = report.cases.filter((c) => c.card === "fictional-contractor" && c.got === "refuse:no_covering_rule").length;
      expect(noCover).toBeGreaterThanOrEqual(8);
      expect(ct.suggestedEscalations).toBe(noCover);
      for (const id of priced) expect(report.cards[id]!.suggestedEscalations, id).toBe(0);
    });
  });
});
