/**
 * Rate-card compiler (T14): a Sheet-shaped template (one CSV per sheet) -> a kernel-validated, hashed card.
 *
 * Owners type prices in major units ("1250.50"); this file turns the text into integer minor units with string
 * arithmetic only (no float ever touches money). Every problem is reported against the exact cell the owner typed:
 * `rules.csv row 4, column "price": "abc" is not an amount ...` (spreadsheet row numbers: the header is row 1).
 * Whatever the compiler cannot see itself (the kernel's own well-formedness rules) is mapped back to a cell through
 * the origin table built while compiling.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { KernelBridge } from "../kernel/index.js";
import { parseCsv } from "./csv.js";

export type TemplateFiles = Record<string, string>;

export interface CompileError {
  file: string;
  /** Spreadsheet row, header = 1. Absent for whole-file problems. */
  row?: number;
  column?: string;
  message: string;
}

export type CompileResult =
  | { ok: true; card: Record<string, unknown>; hash: string }
  | { ok: false; errors: CompileError[] };

export function formatCompileError(e: CompileError): string {
  const where = e.row === undefined ? e.file : e.column === undefined ? `${e.file} row ${e.row}` : `${e.file} row ${e.row}, column "${e.column}"`;
  return `${where}: ${e.message}`;
}

/** Reads every `*.csv` in a template directory. */
export async function readTemplateDir(dir: string): Promise<TemplateFiles> {
  const { readdir } = await import("node:fs/promises");
  const names = (await readdir(dir)).filter((f) => f.endsWith(".csv")).sort();
  if (names.length === 0) throw new Error(`no .csv sheets in ${dir}`);
  return Object.fromEntries(await Promise.all(names.map(async (n) => [n, await readFile(path.join(dir, n), "utf8")] as const)));
}

// ---- cell parsing ----------------------------------------------------------------------------------------------

/** Currency exponent (digits after the decimal point). ISO 4217 minor-unit digits for the few that are not 2. */
const EXPONENT: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };
const exponentOf = (currency: string) => EXPONENT[currency] ?? 2;

/** "1250.50" -> 125050 with integer string math; undefined if not a plain non-negative decimal. */
export function parseMinor(text: string, exp: number): { minor: number } | { error: "format" | "negative" | "precision" | "range" } {
  if (/^-\s*\d/.test(text)) return { error: "negative" };
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return { error: "format" };
  const frac = m[2] ?? "";
  if (frac.length > exp) return { error: "precision" };
  const minor = Number(m[1] + frac.padEnd(exp, "0"));
  return Number.isSafeInteger(minor) ? { minor } : { error: "range" };
}

/** Basis points from a percent cell ("18", "12.5", "0.25"): two decimals of percent at most. */
function parseBps(text: string): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return undefined;
  const bps = Number((m[1] ?? "0") + (m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(bps) ? bps : undefined;
}

const WHOLE = /^\d{1,15}$/;

// ---- sheets ----------------------------------------------------------------------------------------------------

interface Row {
  n: number;
  cell: Record<string, string>;
}

class Ctx {
  errors: CompileError[] = [];
  /** JSON path prefix -> the cell/row it came from; used to map kernel errors back to the sheet. */
  origin = new Map<string, { file: string; row?: number }>();
  err(file: string, row: number | undefined, column: string | undefined, message: string) {
    this.errors.push({ file, ...(row !== undefined && { row }), ...(column !== undefined && { column }), message });
  }
}

function readSheet(ctx: Ctx, files: TemplateFiles, file: string, required: string[], optional: string[] = [], fileRequired = true): Row[] {
  const text = files[file];
  if (text === undefined) {
    if (fileRequired) ctx.err(file, undefined, undefined, "file is missing from the template");
    return [];
  }
  const grid = parseCsv(text);
  const header = (grid[0] ?? []).map((h) => h.trim());
  let missing = false;
  for (const col of required) {
    if (!header.includes(col)) {
      ctx.err(file, 1, undefined, `missing column "${col}"`);
      missing = true;
    }
  }
  if (missing) return [];
  const rows: Row[] = [];
  grid.slice(1).forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return;
    const cell: Record<string, string> = {};
    for (const col of [...required, ...optional]) {
      const at = header.indexOf(col);
      cell[col] = at >= 0 ? (cells[at] ?? "").trim() : "";
    }
    rows.push({ n: i + 2, cell });
  });
  return rows;
}

function money(ctx: Ctx, file: string, r: Row, column: string, currency: string): number | undefined {
  const text = r.cell[column] ?? "";
  const exp = exponentOf(currency);
  const res = parseMinor(text, exp);
  if ("minor" in res) return res.minor;
  if (text === "") ctx.err(file, r.n, column, "is empty: enter an amount");
  else if (res.error === "negative") ctx.err(file, r.n, column, `"${text}" must not be negative`);
  else if (res.error === "precision") ctx.err(file, r.n, column, `"${text}" has too many decimals: ${currency} allows at most ${exp}`);
  else ctx.err(file, r.n, column, `"${text}" is not an amount in ${currency} (digits with at most ${exp} decimals, e.g. 1250${exp > 0 ? `.${"5".padEnd(exp, "0")}`.replace(/^/, " or 1250") : ""})`);
  return undefined;
}

function whole(ctx: Ctx, file: string, r: Row, column: string, opts: { blank?: "open" } = {}): number | null | undefined {
  const text = r.cell[column] ?? "";
  if (text === "" && opts.blank === "open") return null;
  if (WHOLE.test(text)) return Number(text);
  ctx.err(file, r.n, column, text === "" ? "is empty: enter a whole number" : `"${text}" is not a whole number`);
  return undefined;
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const CONDITIONS = ["is", "one_of", "between", "weekday_in", "month_in"];
const CHARGES = ["flat", "per_unit", "tiered", "tiered_per_unit"];

function scalar(text: string): string | number {
  return WHOLE.test(text) ? Number(text) : text;
}

function yesNo(ctx: Ctx, file: string, r: Row, column: string, fallback: boolean | undefined): boolean | undefined {
  const t = (r.cell[column] ?? "").toLowerCase();
  if (t === "") return fallback;
  if (["yes", "y", "true"].includes(t)) return true;
  if (["no", "n", "false"].includes(t)) return false;
  ctx.err(file, r.n, column, `"${r.cell[column]}" is not yes or no`);
  return undefined;
}

function compileCondition(ctx: Ctx, r: Row): Record<string, unknown> | undefined {
  const file = "conditions.csv";
  const field = r.cell.field ?? "";
  const kind = r.cell.condition ?? "";
  const value = r.cell.value ?? "";
  if (field === "") {
    ctx.err(file, r.n, "field", "is empty: name the field this condition looks at");
    return undefined;
  }
  const list = () => value.split("|").map((s) => s.trim());
  switch (kind) {
    case "is":
      if (value === "") {
        ctx.err(file, r.n, "value", "is empty");
        return undefined;
      }
      return { field, op: "eq", value: scalar(value) };
    case "one_of": {
      if (value === "") {
        ctx.err(file, r.n, "value", "is empty: list the options separated by |");
        return undefined;
      }
      return { field, op: "in", values: list().map(scalar) };
    }
    case "between": {
      const min = value === "" ? null : WHOLE.test(value) ? Number(value) : undefined;
      const max = (r.cell.to ?? "") === "" ? null : WHOLE.test(r.cell.to ?? "") ? Number(r.cell.to) : undefined;
      let ok = true;
      if (min === undefined) (ctx.err(file, r.n, "value", `"${value}" is not a whole number`), (ok = false));
      if (max === undefined) (ctx.err(file, r.n, "to", `"${r.cell.to}" is not a whole number`), (ok = false));
      if (!ok) return undefined;
      if (min === null && max === null) {
        ctx.err(file, r.n, "value", "a between condition needs a minimum, a maximum, or both");
        return undefined;
      }
      if (min !== null && max !== null && (min as number) > (max as number)) {
        ctx.err(file, r.n, "to", `${max} is below the minimum ${min}`);
        return undefined;
      }
      return { field, op: "range", min, max };
    }
    case "weekday_in": {
      const days = list().map((d) => d.toLowerCase());
      const bad = days.find((d) => !DAYS.includes(d));
      if (value === "" || bad !== undefined) {
        ctx.err(file, r.n, "value", value === "" ? "is empty: list days like mon|tue" : `"${bad}" is not a weekday (${DAYS.join(", ")})`);
        return undefined;
      }
      return { field, op: "weekday_in", days };
    }
    case "month_in": {
      const items = list();
      const bad = items.find((m) => !/^\d{1,2}$/.test(m) || Number(m) < 1 || Number(m) > 12);
      if (value === "" || bad !== undefined) {
        ctx.err(file, r.n, "value", value === "" ? "is empty: list months like 11|12|1|2" : `"${bad}" is not a month number (1 to 12)`);
        return undefined;
      }
      return { field, op: "month_in", months: items.map(Number) };
    }
    default:
      ctx.err(file, r.n, "condition", `"${kind}" is not a condition (${CONDITIONS.join(", ")})`);
      return undefined;
  }
}

// ---- compile ---------------------------------------------------------------------------------------------------

const META_KEYS = ["id", "label", "comment", "fictional", "currency", "timezone", "version", "valid_days", "hold_hours", "offer_alternatives", "refusal_suggestion", "refusal_suggestion_reply"];
const META_REQUIRED = ["id", "currency", "timezone", "version", "valid_days", "hold_hours"];

export function compileTemplate(files: TemplateFiles, kernel: KernelBridge): CompileResult {
  const ctx = new Ctx();

  // meta
  const meta: Record<string, Row> = {};
  for (const r of readSheet(ctx, files, "meta.csv", ["key", "value"])) {
    const key = r.cell.key ?? "";
    if (!META_KEYS.includes(key)) ctx.err("meta.csv", r.n, "key", `"${key}" is not a setting (${META_KEYS.join(", ")})`);
    else if (meta[key]) ctx.err("meta.csv", r.n, "key", `"${key}" is already set on row ${meta[key].n}`);
    else meta[key] = r;
  }
  const hasMeta = files["meta.csv"] !== undefined;
  if (hasMeta) for (const k of META_REQUIRED) if (!meta[k] && ctx.errors.every((e) => e.file !== "meta.csv" || e.row !== 1)) ctx.err("meta.csv", undefined, undefined, `missing row "${k}"`);
  const text = (k: string) => meta[k]?.cell.value ?? "";
  const currency = text("currency");
  const card: Record<string, unknown> = {};
  const setText = (k: string, jsonKey: string) => {
    if (meta[k] && text(k) !== "") card[jsonKey] = text(k);
  };
  setText("id", "id");
  setText("label", "label");
  setText("comment", "comment");
  setText("currency", "currency");
  setText("timezone", "timezone");
  setText("refusal_suggestion", "refusalSuggestion");
  setText("refusal_suggestion_reply", "refusalSuggestionReply");
  const metaInt = (k: string, jsonKey: string) => {
    const r = meta[k];
    if (r) {
      const v = whole(ctx, "meta.csv", r, "value");
      if (v !== undefined && v !== null) card[jsonKey] = v;
    }
  };
  metaInt("version", "version");
  metaInt("valid_days", "validDays");
  metaInt("hold_hours", "holdHours");
  for (const [k, jsonKey] of [["fictional", "fictional"], ["offer_alternatives", "offerAlternatives"]] as const) {
    const r = meta[k];
    if (r) {
      const v = yesNo(ctx, "meta.csv", r, "value", undefined);
      if (v !== undefined) card[jsonKey] = v;
    }
  }

  // required fields
  const requiredFields: unknown[] = [];
  for (const r of readSheet(ctx, files, "required_fields.csv", ["field", "question"])) {
    if (r.cell.field === "") ctx.err("required_fields.csv", r.n, "field", "is empty");
    else if (r.cell.question === "") ctx.err("required_fields.csv", r.n, "question", "is empty: write the question the agent should ask");
    else {
      ctx.origin.set(`requiredFields[${requiredFields.length}]`, { file: "required_fields.csv", row: r.n });
      requiredFields.push({ field: r.cell.field, question: r.cell.question });
    }
  }
  card.requiredFields = requiredFields;
  ctx.origin.set("requiredFields", { file: "required_fields.csv" });

  // conditions grouped by rule_id (row order kept: it is the card's condition order)
  const condRows = readSheet(ctx, files, "conditions.csv", ["rule_id", "field", "condition", "value"], ["to"]);
  const tierRows = readSheet(ctx, files, "tiers.csv", ["rule_id", "up_to", "price"], [], false);
  const ruleRows = readSheet(ctx, files, "rules.csv", ["rule_id", "label", "core", "charge", "price", "per_field"], ["included"]);
  const minRows = readSheet(ctx, files, "minimums.csv", ["rule_id", "label", "field", "min", "below"], [], false);

  const ids = new Map<string, number>();
  const claim = (file: string, r: Row): boolean => {
    const id = r.cell.rule_id ?? "";
    if (id === "") {
      ctx.err(file, r.n, "rule_id", "is empty");
      return false;
    }
    const seen = ids.get(id);
    if (seen !== undefined) {
      ctx.err(file, r.n, "rule_id", `"${id}" is already used on row ${seen}`);
      return false;
    }
    ids.set(id, r.n);
    return true;
  };
  const ruleIds = new Set<string>();
  const ruleClaimed = ruleRows.map((r) => {
    const ok = claim("rules.csv", r);
    if (r.cell.rule_id) ruleIds.add(r.cell.rule_id);
    return ok;
  });
  const minClaimed = minRows.map((r) => {
    const ok = claim("minimums.csv", r);
    if (r.cell.rule_id) ruleIds.add(r.cell.rule_id);
    return ok;
  });
  const taxRows = readSheet(ctx, files, "taxes.csv", ["rule_id", "label", "rate_percent"]);
  const taxClaimed = taxRows.map((r) => claim("taxes.csv", r));

  // If rules.csv itself is unreadable, "unknown rule_id" on the other sheets would only be noise.
  const rulesUnreadable = ctx.errors.some((e) => e.file === "rules.csv" && (e.row === 1 || e.row === undefined));
  const condsOf = new Map<string, { r: Row; cond: Record<string, unknown> | undefined }[]>();
  for (const r of condRows) {
    const id = r.cell.rule_id ?? "";
    if (!ruleIds.has(id)) {
      if (rulesUnreadable) continue;
      ctx.err("conditions.csv", r.n, "rule_id", `"${id}" is not a rule_id in rules.csv`);
      continue;
    }
    const list = condsOf.get(id) ?? [];
    list.push({ r, cond: compileCondition(ctx, r) });
    condsOf.set(id, list);
  }
  const tiersOf = new Map<string, Row[]>();
  for (const r of tierRows) {
    const id = r.cell.rule_id ?? "";
    if (!ruleIds.has(id)) {
      if (!rulesUnreadable) ctx.err("tiers.csv", r.n, "rule_id", `"${id}" is not a rule_id in rules.csv`);
    } else tiersOf.set(id, [...(tiersOf.get(id) ?? []), r]);
  }

  const conditionsFor = (id: string, base: string): unknown[] => {
    const out: unknown[] = [];
    for (const { r, cond } of condsOf.get(id) ?? []) {
      ctx.origin.set(`${base}.when[${out.length}]`, { file: "conditions.csv", row: r.n });
      if (cond) out.push(cond);
    }
    return out;
  };

  const rules: unknown[] = [];
  ruleRows.forEach((r, idx) => {
    const id = r.cell.rule_id ?? "";
    const base = `rules[${rules.length}]`;
    const core = yesNo(ctx, "rules.csv", r, "core", false);
    const kind = r.cell.charge ?? "";
    let charge: Record<string, unknown> | undefined;
    const perField = () => {
      if ((r.cell.per_field ?? "") === "") {
        ctx.err("rules.csv", r.n, "per_field", `is empty: a ${kind} charge needs the field it counts or bands on`);
        return undefined;
      }
      return r.cell.per_field;
    };
    const tiers = (perUnit: boolean) => {
      const trs = tiersOf.get(id) ?? [];
      if (trs.length === 0) {
        ctx.err("rules.csv", r.n, "charge", `a ${kind} charge needs rows for "${id}" in tiers.csv`);
        return undefined;
      }
      const out: { upTo: number | null; amount: number }[] = [];
      let good = true;
      trs.forEach((t, j) => {
        ctx.origin.set(`${base}.charge.tiers[${j}]`, { file: "tiers.csv", row: t.n });
        const upTo = whole(ctx, "tiers.csv", t, "up_to", { blank: "open" });
        const amount = money(ctx, "tiers.csv", t, "price", currency);
        if (upTo === undefined || amount === undefined) good = false;
        else out.push({ upTo, amount });
      });
      void perUnit;
      return good ? out : undefined;
    };
    switch (kind) {
      case "flat": {
        const amount = money(ctx, "rules.csv", r, "price", currency);
        if (amount !== undefined) charge = { kind, amount };
        break;
      }
      case "per_unit": {
        const unitAmount = money(ctx, "rules.csv", r, "price", currency);
        const field = perField();
        const included = (r.cell.included ?? "") === "" ? 0 : whole(ctx, "rules.csv", r, "included");
        if (unitAmount !== undefined && field !== undefined && included !== undefined && included !== null) {
          charge = { kind, field, unitAmount, ...(included > 0 && { included }) };
        }
        break;
      }
      case "tiered":
      case "tiered_per_unit": {
        const field = perField();
        const t = tiers(kind === "tiered_per_unit");
        if (field !== undefined && t !== undefined) charge = { kind, field, tiers: t };
        break;
      }
      default:
        ctx.err("rules.csv", r.n, "charge", `"${kind}" is not a charge type (${CHARGES.join(", ")})`);
    }
    if (r.cell.label === "") ctx.err("rules.csv", r.n, "label", "is empty: the label is what the customer sees on the quote line");
    ctx.origin.set(base, { file: "rules.csv", row: r.n });
    const when = conditionsFor(id, base);
    if (ruleClaimed[idx] && charge && core !== undefined && r.cell.label !== "") {
      rules.push({ ruleId: id, ...(core && { core: true }), label: r.cell.label, when, charge });
    } else rules.push(undefined);
  });
  ctx.origin.set("rules", { file: "rules.csv" });
  card.rules = rules.filter((x) => x !== undefined);
  // origin indices refer to positions among *kept* rules; only matters when there are already errors, which win anyway.

  const taxLines: unknown[] = [];
  taxRows.forEach((r, idx) => {
    const bps = parseBps(r.cell.rate_percent ?? "");
    if (bps === undefined) ctx.err("taxes.csv", r.n, "rate_percent", `"${r.cell.rate_percent}" is not a percentage (digits with at most 2 decimals, e.g. 18 or 12.5)`);
    else if (r.cell.label === "") ctx.err("taxes.csv", r.n, "label", "is empty");
    else if (taxClaimed[idx]) {
      ctx.origin.set(`taxLines[${taxLines.length}]`, { file: "taxes.csv", row: r.n });
      taxLines.push({ ruleId: r.cell.rule_id, label: r.cell.label, rateBps: bps });
    }
  });
  card.taxLines = taxLines;

  const minimums: unknown[] = [];
  minRows.forEach((r, idx) => {
    const min = whole(ctx, "minimums.csv", r, "min");
    const below = r.cell.below ?? "";
    if (below !== "refuse" && below !== "raise_to_min") ctx.err("minimums.csv", r.n, "below", `"${below}" is not a policy (refuse, raise_to_min)`);
    else if (min !== undefined && min !== null && minClaimed[idx] && r.cell.field !== "") {
      const base = `minimums[${minimums.length}]`;
      ctx.origin.set(base, { file: "minimums.csv", row: r.n });
      const when = conditionsFor(r.cell.rule_id ?? "", base);
      minimums.push({ ruleId: r.cell.rule_id, label: r.cell.label, field: r.cell.field, min, below, ...(when.length > 0 && { when }) });
    }
  });
  if (minimums.length > 0) card.minimums = minimums;

  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors };

  // The kernel is the judge of well-formedness; its JSON path is mapped back to the cell that produced it.
  const verdict = kernel.validateCard(card);
  if (!verdict.ok) {
    return { ok: false, errors: [verdict.error === "invalid_card" ? kernelError(ctx, verdict.path, verdict.message) : { file: "card", message: "the compiled card is not valid JSON" }] };
  }
  return { ok: true, card, hash: kernel.rateCardHash(card) };
}

const COLUMN_FOR: Record<string, string> = {
  ruleId: "rule_id", amount: "price", unitAmount: "price", included: "included", min: "value", max: "to", upTo: "up_to",
  days: "value", months: "value", values: "value", rateBps: "rate_percent", label: "label", field: "field", below: "below",
};

function kernelError(ctx: Ctx, jsonPath: string, message: string): CompileError {
  const parts = jsonPath.split(".");
  for (let n = parts.length; n >= 1; n--) {
    const hit = ctx.origin.get(parts.slice(0, n).join("."));
    if (hit) {
      // A deeper path than the origin entry names a field of that row: map it to the column that holds it.
      const leaf = parts[parts.length - 1]?.replace(/\[\d+\]/g, "") ?? "";
      const column = n < parts.length ? COLUMN_FOR[leaf] : undefined;
      return { file: hit.file, ...(hit.row !== undefined && { row: hit.row }), ...(column && hit.row !== undefined && { column }), message };
    }
  }
  const settings: Record<string, string> = { currency: "currency", validDays: "valid_days", holdHours: "hold_hours" };
  if (settings[jsonPath]) return { file: "meta.csv", message: `${settings[jsonPath]} ${message}` };
  return { file: "card", message: `${jsonPath || "card"}: ${message}` };
}
