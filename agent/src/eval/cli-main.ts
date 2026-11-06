import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { runEval, type EvalReport, type LangMetrics } from "./run-eval.js";
import { renderResultsMd } from "./results-md.js";
import { DEFAULT_BASELINES_DIR, DEFAULT_RESULTS_PATH, LANGS } from "./sets.js";

export interface EvalPaths {
  baselinesDir?: string;
  resultsPath?: string;
  setsDir?: string;
  recordingsDir?: string;
}

export interface EvalMainResult {
  code: number;
  out: string;
}

const pct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

export const baselineName = (r: EvalReport): string => `${r.provenance.modelId}.${r.provenance.promptHash8}.json`;
const stringify = (r: EvalReport): string => `${JSON.stringify(r, null, 2)}\n`;

/** Per-language console table. Plain text, fixed columns, no timestamps. */
export function renderTable(r: EvalReport): string {
  const cols = ["lang", "n", "field acc", "schema-valid", "mean conf", "outcome acc", "UNSAFE QUOTES", "wrong-price", "missed"];
  const row = (name: string, m: LangMetrics): string[] => [
    name,
    String(m.cases),
    pct(m.extraction.fieldAccuracyBps),
    pct(m.extraction.schemaValidBps),
    pct(m.extraction.meanConfidenceBps),
    pct(m.pipeline.outcomeAccuracyBps),
    String(m.pipeline.unsafeQuotes),
    String(m.pipeline.wrongPriceQuotes),
    String(m.pipeline.missedQuotes),
  ];
  const rows = [cols, ...LANGS.map((l) => row(l, r.languages[l])), row("ALL", r.overall)];
  const w = cols.map((_, i) => Math.max(...rows.map((x) => x[i]!.length)));
  const line = (x: string[]) => x.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd();
  return [line(rows[0]!), line(w.map((n) => "-".repeat(n))), ...rows.slice(1).map(line)].join("\n");
}

/** Per-card console table: how much of each card's traffic was priced versus refused. */
export function renderCardTable(r: EvalReport): string {
  const cols = ["card", "n", "quotes", "refusals", "clarify", "refusal share", "out-of-coverage quotes", "suggested", "outcome acc"];
  const rows = [
    cols,
    ...Object.entries(r.cards).map(([id, c]) => [
      id,
      String(c.cases),
      String(c.quotes),
      String(c.refusals),
      String(c.clarifications),
      pct(c.refusalShareBps),
      String(c.outOfCoverageQuotes),
      `${c.suggestedEscalations}/${c.noCoveringRuleRefusals}`,
      pct(c.pipeline.outcomeAccuracyBps),
    ]),
  ];
  const w = cols.map((_, i) => Math.max(...rows.map((x) => x[i]!.length)));
  const line = (x: string[]) => x.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd();
  return [line(rows[0]!), line(w.map((n) => "-".repeat(n))), ...rows.slice(1).map(line)].join("\n");
}

function render(r: EvalReport): string {
  const u = r.overall.pipeline;
  const unsafeIds = r.cases.filter((c) => c.unsafe).map((c) => `${c.id} (gold ${c.gold})`);
  return [
    `eval: ${r.provenance.label}`,
    `model ${r.provenance.modelId}  prompt ${r.provenance.promptHash8}  cards ${r.provenance.rateCards.map((c) => c.id).join(", ")}  cases ${r.inputs.caseCount}`,
    "These recordings are hand-seeded. The numbers check the harness and the safety gates; they are NOT a measurement of any model's accuracy in any language.",
    "",
    renderTable(r),
    "",
    renderCardTable(r),
    "",
    `unsafe quotes issued: ${u.unsafeQuotes}${u.unsafeQuotes ? `  <-- gold says clarify/refuse: ${unsafeIds.join(", ")}` : ""}`,
    `quotes at the wrong price: ${u.wrongPriceQuotes}${u.wrongPriceCaseIds.length ? ` (${u.wrongPriceCaseIds.join(", ")})` : ""}`,
    "",
  ].join("\n");
}

type Flat = Record<string, string>;
/** Leaf paths -> JSON text. The case list is keyed by case id so diffs name the case. */
function flatten(value: unknown, prefix = "", out: Flat = {}): Flat {
  if (Array.isArray(value) && prefix === "cases") {
    for (const c of value as { id: string }[]) flatten(c, `cases.${c.id}`, out);
  } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = JSON.stringify(value);
  return out;
}

export function diffReports(baseline: unknown, now: unknown): string[] {
  const a = flatten(baseline);
  const b = flatten(now);
  const problems: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[k] !== b[k]) problems.push(`DRIFT ${k}: baseline ${a[k] ?? "(absent)"}, now ${b[k] ?? "(absent)"}`);
  }
  return problems;
}

/**
 * `pnpm eval [--write-baseline] [--check]`.
 *  default          run, print the table, write RESULTS.md, and write the baseline only if none exists for this model + prompt hash
 *  --write-baseline run and (over)write the baseline and RESULTS.md
 *  --check          run and compare to the committed baseline and RESULTS.md; any difference is a failure; writes nothing
 */
export async function evalMain(argv: string[], deps: { pool: Pool } & EvalPaths): Promise<EvalMainResult> {
  const known = new Set(["--write-baseline", "--check"]);
  const bad = argv.filter((a) => a !== "--" && !known.has(a));
  if (bad.length) return { code: 2, out: `unknown argument(s): ${bad.join(" ")}\nusage: pnpm eval [--write-baseline] [--check]\n` };
  const check = argv.includes("--check");
  const writeBaseline = argv.includes("--write-baseline");
  if (check && writeBaseline) return { code: 2, out: "--check and --write-baseline are mutually exclusive\n" };

  const baselinesDir = deps.baselinesDir ?? DEFAULT_BASELINES_DIR;
  const resultsPath = deps.resultsPath ?? DEFAULT_RESULTS_PATH;
  const report = await runEval({
    pool: deps.pool,
    ...(deps.setsDir && { setsDir: deps.setsDir }),
    ...(deps.recordingsDir && { recordingsDir: deps.recordingsDir }),
  });
  const baselinePath = path.join(baselinesDir, baselineName(report));
  const md = renderResultsMd(report);
  let out = render(report);

  if (check) {
    const problems: string[] = [];
    if (!existsSync(baselinePath)) {
      problems.push(`no baseline at ${path.relative(process.cwd(), baselinePath)} for model ${report.provenance.modelId} + prompt hash ${report.provenance.promptHash8} (changing the prompt needs a new baseline)`);
    } else {
      problems.push(...diffReports(JSON.parse(await readFile(baselinePath, "utf8")), report));
    }
    const published = existsSync(resultsPath) ? await readFile(resultsPath, "utf8") : undefined;
    if (published !== md) problems.push("RESULTS.md is missing or differs from what this run produces (do not hand-edit it)");
    if (problems.length === 0) return { code: 0, out: `${out}check: OK (matches baseline ${baselineName(report)} and RESULTS.md)\n` };
    out += `check: FAILED, ${problems.length} difference(s)\n${problems.map((p) => `  ${p}`).join("\n")}\n`;
    out += "If the change is intended, run `pnpm eval --write-baseline` and commit baseline + RESULTS.md.\n";
    return { code: 1, out };
  }

  await mkdir(baselinesDir, { recursive: true });
  await mkdir(path.dirname(resultsPath), { recursive: true });
  const wroteBaseline = writeBaseline || !existsSync(baselinePath);
  if (wroteBaseline) await writeFile(baselinePath, stringify(report));
  await writeFile(resultsPath, md);
  out += `wrote ${path.relative(process.cwd(), resultsPath)}${wroteBaseline ? ` and ${path.relative(process.cwd(), baselinePath)}` : `; kept existing baseline ${baselineName(report)} (use --write-baseline to replace)`}\n`;
  return { code: 0, out };
}
