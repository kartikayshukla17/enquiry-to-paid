import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { PROVENANCE_LABEL, runEval, type EvalReport } from "./run-eval.js";

let db: TestDb;
let report: EvalReport;
beforeAll(async () => {
  db = await createTestDb();
  report = await runEval({ pool: db.pool });
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
    for (const m of Object.values(report.languages)) {
      expect(m.cases).toBeGreaterThan(0);
      expect(m.extraction.fieldsTotal).toBe(m.cases * 5);
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
    expect(byId["hg-16"]?.got).toBe("quote");
    expect(byId["hg-16"]?.wrongPrice).toBe(true);
    expect(byId["en-01"]?.wrongPrice).toBe(false);
    expect(report.languages.hinglish.pipeline.wrongPriceCaseIds).toContain("hg-16");
  });

  it("scores integers only (basis points), never floats", () => {
    for (const m of [...Object.values(report.languages), report.overall]) {
      for (const v of [m.extraction.fieldAccuracyBps, m.extraction.schemaValidBps, m.extraction.meanConfidenceBps, m.pipeline.outcomeAccuracyBps]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});
