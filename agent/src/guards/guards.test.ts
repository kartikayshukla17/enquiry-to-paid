/**
 * Repo-wide guards (greps over the source tree) for two hard rules:
 *  1. The engine is generic: no vertical is named in kernel or agent source. Verticals live in rate-cards/,
 *     fixtures and eval data, and in tests.
 *  2. No floating-point money anywhere in the money path.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function walk(dir: string, ext: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "target" || name === "dist") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const rel = (p: string): string => path.relative(REPO, p);
const isTest = (p: string): boolean => /\.test\.ts$/.test(p);

/** Engine source: Rust kernel library code and agent TypeScript, tests excluded (tests may name verticals as data). */
const engineSources = (): string[] => [
  ...walk(path.join(REPO, "kernel", "src"), [".rs"]),
  ...walk(path.join(REPO, "agent", "src"), [".ts"]).filter((p) => !isTest(p)),
];

describe("guard: the engine has no vertical-specific code", () => {
  const VERTICALS = /photograph|supplier|contractor/i;

  it("kernel/src and agent/src (non-test) never name a vertical", () => {
    const hits = engineSources().flatMap((p) =>
      readFileSync(p, "utf8")
        .split("\n")
        .map((line, i) => ({ file: rel(p), line: i + 1, text: line.trim() }))
        .filter((l) => VERTICALS.test(l.text)),
    );
    expect(hits).toEqual([]);
  });

  it("the guard really bites: a planted vertical string is caught by the same pattern", () => {
    expect(VERTICALS.test('if (card.id === "fictional-photographer") {')).toBe(true);
    expect(VERTICALS.test("let is_contractor = true;")).toBe(true);
    expect(VERTICALS.test("supplier")).toBe(true);
    expect(VERTICALS.test("per_unit with included quantity")).toBe(false);
  });
});

describe("guard: no floating-point money", () => {
  it("kernel/src has no f32/f64 and no float parsing", () => {
    const hits = walk(path.join(REPO, "kernel", "src"), [".rs"]).flatMap((p) =>
      readFileSync(p, "utf8")
        .split("\n")
        .map((line, i) => ({ file: rel(p), line: i + 1, text: line.trim() }))
        .filter((l) => /\bf32\b|\bf64\b|parse::<f|as f(32|64)/.test(l.text)),
    );
    expect(hits).toEqual([]);
  });

  it("agent/src has no parseFloat, and toFixed only where it formats a basis-point percentage", () => {
    // Documented exceptions: eval and provider-gate tables print integer basis points as "12.3%" (`bps / 100`).
    // That is a display of a score, never an amount of money.
    const hits = engineSources()
      .filter((p) => p.endsWith(".ts"))
      .flatMap((p) =>
        readFileSync(p, "utf8")
          .split("\n")
          .map((line, i) => ({ file: rel(p), line: i + 1, text: line.trim() }))
          .filter((l) => /parseFloat|toFixed|toPrecision/.test(l.text) && !/\(bps \/ 100\)\.toFixed\(1\)/.test(l.text)),
      );
    expect(hits).toEqual([]);
  });

  it("every number in every rate card is an integer (minor units and basis points)", () => {
    const cards = walk(path.join(REPO, "rate-cards"), [".json"]);
    expect(cards.length).toBeGreaterThanOrEqual(3);
    for (const p of cards) {
      const text = readFileSync(p, "utf8");
      // A JSON number with a fraction or exponent, outside strings.
      const withoutStrings = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      expect(withoutStrings.match(/-?\d+\.\d+|\d[eE][+-]?\d/g) ?? [], rel(p)).toEqual([]);
    }
  });

  it("the kernel refuses a float in a card or in fields instead of rounding it", () => {
    // Covered in kernel/tests/evaluate.rs (floats_and_malformed_input_are_typed_errors); asserted here as a presence check.
    const t = readFileSync(path.join(REPO, "kernel", "tests", "evaluate.rs"), "utf8");
    expect(t).toContain("floats_and_malformed_input_are_typed_errors");
  });
});
