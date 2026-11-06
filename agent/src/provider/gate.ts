import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { runEval, type EvalReport, type LangMetrics } from "../eval/run-eval.js";
import { DEFAULT_BASELINES_DIR, LANGS, sha256, type Lang } from "../eval/sets.js";
import { DEFAULT_REGISTRY_PATH, loadRegistry, registryKey, type Registry } from "../llm/registry.js";
import type { LlmProvider } from "../llm/types.js";
import { resolveCandidate } from "./candidates.js";

export interface GateDeps {
  pool: Pool;
  registryPath?: string;
  baselinesDir?: string;
  setsDir?: string;
  recordingsDir?: string;
  /** Test hook: supply the candidate directly instead of resolving it by name. */
  resolve?: (provider: string, model: string) => Promise<LlmProvider>;
  /** `enable` only: also make the candidate the reference model for later candidates. */
  promote?: boolean;
}

const LANG_NAMES: Record<Lang, string> = { en: "english", hinglish: "hinglish", hi: "hindi" };

type Metric = { name: string; kind: "pct" | "count"; get: (m: LangMetrics) => number };
/** Higher is better for pct metrics; lower is better for counts. */
const METRICS: Metric[] = [
  { name: "fieldAccuracy", kind: "pct", get: (m) => m.extraction.fieldAccuracyBps },
  { name: "schemaValidRate", kind: "pct", get: (m) => m.extraction.schemaValidBps },
  { name: "outcomeAccuracy", kind: "pct", get: (m) => m.pipeline.outcomeAccuracyBps },
  { name: "unsafeQuotes", kind: "count", get: (m) => m.pipeline.unsafeQuotes },
  { name: "wrongPriceQuotes", kind: "count", get: (m) => m.pipeline.wrongPriceQuotes },
];

export interface Regression {
  language: string;
  metric: string;
  candidate: number;
  baseline: number;
  against: string;
  line: string;
}

const pct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

/** Every per-language metric where `cand` is worse than `base`. Counts must not exceed; rates must not drop. */
export function compareToBaseline(cand: EvalReport, base: EvalReport, against: string): Regression[] {
  const out: Regression[] = [];
  for (const l of LANGS) {
    for (const m of METRICS) {
      const c = m.get(cand.languages[l]);
      const b = m.get(base.languages[l]);
      const worse = m.kind === "pct" ? c < b : c > b;
      if (!worse) continue;
      const language = LANG_NAMES[l];
      const line =
        m.kind === "pct"
          ? `BLOCKED: ${language}.${m.name} ${pct(c)} < baseline ${pct(b)}`
          : `BLOCKED: ${language}.${m.name} ${c} > baseline ${b}`;
      out.push({ language, metric: m.name, candidate: c, baseline: b, against, line });
    }
  }
  return out;
}

export interface GateResult {
  ok: boolean;
  key: string;
  regressions: Regression[];
  report: EvalReport;
  /** Console text, ending in the verdict. */
  out: string;
}

function summaryTable(r: EvalReport): string {
  const cols = ["lang", "field acc", "schema-valid", "outcome acc", "unsafe", "wrong-price"];
  const rows = LANGS.map((l) => {
    const m = r.languages[l];
    return [LANG_NAMES[l], pct(m.extraction.fieldAccuracyBps), pct(m.extraction.schemaValidBps), pct(m.pipeline.outcomeAccuracyBps), String(m.pipeline.unsafeQuotes), String(m.pipeline.wrongPriceQuotes)];
  });
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((x) => x[i]!.length)));
  const line = (x: string[]) => x.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd();
  return [line(cols), ...rows.map(line)].join("\n");
}

async function readReport(file: string): Promise<EvalReport> {
  return JSON.parse(await readFile(file, "utf8")) as EvalReport;
}

/**
 * The gate. Runs the T7 eval sets for the candidate and compares PER LANGUAGE to the recorded baseline of the
 * currently enabled model (and to the candidate's own baseline if it already has one). Any metric worse in any
 * language blocks. Writes nothing.
 */
export async function checkEnable(provider: string, model: string, deps: GateDeps): Promise<GateResult> {
  const registry = loadRegistry(deps.registryPath ?? DEFAULT_REGISTRY_PATH);
  const baselinesDir = deps.baselinesDir ?? DEFAULT_BASELINES_DIR;
  const key = registryKey(provider, model);
  const current = registry.enabled[registry.current];
  if (!current) throw new Error(`registry "current" (${registry.current}) is not in "enabled"`);

  const llm = await (deps.resolve ?? ((p, m) => resolveCandidate(p, m, deps.recordingsDir)))(provider, model);
  const report = await runEval({
    pool: deps.pool,
    llm,
    candidate: { provider, modelId: model, label: `measured on fictional data; ${provider}/${model} offline candidate, not a live model` },
    ...(deps.setsDir && { setsDir: deps.setsDir }),
    ...(deps.recordingsDir && { recordingsDir: deps.recordingsDir }),
  });

  const refs: { label: string; file: string }[] = [{ label: `${registry.current} (${current.baseline})`, file: path.join(baselinesDir, current.baseline) }];
  const own = path.join(baselinesDir, ownBaselineName(report));
  if (key !== registry.current && existsSync(own)) refs.push({ label: `own baseline (${ownBaselineName(report)})`, file: own });

  const regressions: Regression[] = [];
  for (const ref of refs) regressions.push(...compareToBaseline(report, await readReport(ref.file), ref.label));

  const lines = [`gate: candidate ${key} vs baseline ${refs[0]!.label}`, summaryTable(report), ""];
  const seen = new Set<string>();
  for (const r of regressions) if (!seen.has(r.line)) (seen.add(r.line), lines.push(r.line));
  const ok = regressions.length === 0;
  lines.push(ok ? `PASS: ${key} meets or beats the baseline in every language on every metric` : `${seen.size} regression(s): ${key} cannot be enabled`);
  return { ok, key, regressions, report, out: `${lines.join("\n")}\n` };
}

export const ownBaselineName = (r: EvalReport): string => `${r.provenance.modelId}.${r.provenance.promptHash8}.json`;

/** Gate, and only on pass: write the candidate's own baseline and add it to the registry. */
export async function enableProvider(provider: string, model: string, deps: GateDeps): Promise<GateResult> {
  const res = await checkEnable(provider, model, deps);
  if (!res.ok) return { ...res, out: `${res.out}NOT ENABLED: registry unchanged\n` };
  const registryPath = deps.registryPath ?? DEFAULT_REGISTRY_PATH;
  const baselinesDir = deps.baselinesDir ?? DEFAULT_BASELINES_DIR;
  const file = ownBaselineName(res.report);
  const text = `${JSON.stringify(res.report, null, 2)}\n`;
  await mkdir(baselinesDir, { recursive: true });
  await writeFile(path.join(baselinesDir, file), text);
  const registry: Registry = loadRegistry(registryPath);
  registry.enabled[res.key] = { provider, model, promptHash8: res.report.provenance.promptHash8, baseline: file, enabledAt: sha256(text) };
  if (deps.promote) registry.current = res.key;
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return { ...res, out: `${res.out}ENABLED ${res.key}: wrote baseline ${file} and registry entry (enabledAt ${sha256(text).slice(0, 12)})${deps.promote ? "; now the reference model" : ""}\n` };
}
