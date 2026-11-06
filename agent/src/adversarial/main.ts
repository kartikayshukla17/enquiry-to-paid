import type { Pool } from "pg";
import { runAdversarial, type AdvCategoryRow, type AdvReport } from "./run.js";

export interface AdvMainResult {
  code: number;
  out: string;
}

const LABEL = "measured on fictional data; recorded-fixture provider, not a live model";

export function renderAdvTable(r: AdvReport): string {
  const cols = ["category", "cases", "fooled-model", "quotes issued", "refused/honest ok", "disclosures ok"];
  const row = (x: AdvCategoryRow): string[] => [
    x.category,
    String(x.cases),
    String(x.fooled),
    String(x.quotes),
    `${x.ok}/${x.cases}`,
    x.disclosureCases === 0 ? "-" : `${x.disclosureCorrect}/${x.disclosureCases}`,
  ];
  const rows = [cols, ...r.categories.map(row), row(r.total)];
  const w = cols.map((_, i) => Math.max(...rows.map((x) => x[i]!.length)));
  const line = (x: string[]) => x.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd();
  return [line(rows[0]!), line(w.map((n) => "-".repeat(n))), ...rows.slice(1).map(line)].join("\n");
}

/**
 * `pnpm adversarial`: replays the hostile set offline and exits non-zero on any violation: a quote issued, a wrong
 * outcome, a number in a reply, a missing escalation, a wrong disclosure, or customer text reaching the kernel untyped.
 */
export async function adversarialMain(
  argv: string[],
  deps: { pool: Pool; casesDir?: string; recordingsDir?: string },
): Promise<AdvMainResult> {
  const bad = argv.filter((a) => a !== "--");
  if (bad.length) return { code: 2, out: `unknown argument(s): ${bad.join(" ")}\nusage: pnpm adversarial\n` };
  const r = await runAdversarial({
    pool: deps.pool,
    ...(deps.casesDir && { casesDir: deps.casesDir }),
    ...(deps.recordingsDir && { recordingsDir: deps.recordingsDir }),
  });
  const head = [
    `adversarial: ${LABEL}`,
    "Recordings are hand-seeded; cases marked fooled script a model that obeyed the attack. This checks the pipeline's gates, not any model.",
    "",
    renderAdvTable(r),
    "",
    `quotes issued: ${r.total.quotes} (target 0)`,
    `disclosure replies correct: ${r.total.disclosureCorrect}/${r.total.disclosureCases}`,
    `kernel calls: ${r.kernelCalls}, calls with anything but typed fields: ${r.kernelInputViolations.length}`,
    "",
  ];
  if (r.violations.length === 0) return { code: 0, out: `${head.join("\n")}adversarial: OK, every case refused or answered honestly\n` };
  return { code: 1, out: `${head.join("\n")}adversarial: FAILED, ${r.violations.length} violation(s)\n${r.violations.map((v) => `  ${v}`).join("\n")}\n` };
}
