import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { parseCsv, toCsv } from "./csv.js";
import { compileTemplate, formatCompileError, readTemplateDir, type TemplateFiles } from "./compile.js";
import { REPO_ROOT } from "./paths.js";

const TEMPLATE = path.join(REPO_ROOT, "rate-cards/templates/fictional-banquet-template");
const BANQUET_JSON = path.join(REPO_ROOT, "rate-cards/fictional-banquet.json");

let kernel: KernelBridge;
let files: TemplateFiles;
beforeAll(async () => {
  kernel = await loadKernel();
  files = await readTemplateDir(TEMPLATE);
});

/** Sets one cell (spreadsheet row numbers: the header is row 1) in a copy of the template. */
function edit(file: string, row: number, column: string, value: string): TemplateFiles {
  const rows = parseCsv(files[file] ?? "");
  const col = (rows[0] ?? []).indexOf(column);
  if (col < 0) throw new Error(`test setup: no column ${column}`);
  (rows[row - 1] as string[])[col] = value;
  return { ...files, [file]: toCsv(rows) };
}

function errorsOf(f: TemplateFiles): string[] {
  const r = compileTemplate(f, kernel);
  if (r.ok) throw new Error("expected compile errors");
  return r.errors.map(formatCompileError);
}

describe("template compile: the happy path", () => {
  it("the banquet template compiles to a card with the SAME kernel hash as rate-cards/fictional-banquet.json", async () => {
    const r = compileTemplate(files, kernel);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const json = JSON.parse(await readFile(BANQUET_JSON, "utf8")) as unknown;
    expect(r.card).toEqual(json);
    expect(r.hash).toBe(kernel.rateCardHash(json));
    expect(kernel.validateCard(r.card)).toEqual({ ok: true });
  });

  it("is deterministic: same template, same hash, 20 runs", () => {
    const hashes = new Set(Array.from({ length: 20 }, () => (compileTemplate(files, kernel) as { hash: string }).hash));
    expect(hashes.size).toBe(1);
  });

  it("money comes from decimal text without floats: 1250.50 is 125050 minor units", () => {
    const r = compileTemplate(edit("rules.csv", 4, "price", "1250.50"), kernel);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.card as { rules: { charge: { unitAmount: number } }[] }).rules[2]?.charge.unitAmount).toBe(125050);
  });

  it("a Sheets-style export (CRLF, BOM, quoted cells) compiles to the same card", () => {
    const messy: TemplateFiles = Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, "﻿" + v.replace(/\n/g, "\r\n")]),
    );
    const a = compileTemplate(files, kernel);
    const b = compileTemplate(messy, kernel);
    expect(b.ok && a.ok && b.hash === a.hash).toBe(true);
  });
});

describe("template compile: errors name the exact cell", () => {
  it("a price that is not a number", () => {
    expect(errorsOf(edit("rules.csv", 4, "price", "abc"))).toContain(
      'rules.csv row 4, column "price": "abc" is not an amount in INR (digits with at most 2 decimals, e.g. 1250 or 1250.50)',
    );
  });

  it("a float-looking or over-precise price", () => {
    expect(errorsOf(edit("rules.csv", 2, "price", "1500.505"))[0]).toBe('rules.csv row 2, column "price": "1500.505" has too many decimals: INR allows at most 2');
    expect(errorsOf(edit("rules.csv", 2, "price", "1.5e3"))[0]).toMatch(/^rules\.csv row 2, column "price": "1\.5e3" is not an amount/);
  });

  it("a negative price", () => {
    expect(errorsOf(edit("rules.csv", 3, "price", "-100"))).toContain('rules.csv row 3, column "price": "-100" must not be negative');
  });

  it("an unknown condition", () => {
    expect(errorsOf(edit("conditions.csv", 3, "condition", "sometimes"))).toContain(
      'conditions.csv row 3, column "condition": "sometimes" is not a condition (is, one_of, between, weekday_in, month_in)',
    );
  });

  it("a bad date class", () => {
    expect(errorsOf(edit("conditions.csv", 3, "value", "mon|funday"))).toContain(
      'conditions.csv row 3, column "value": "funday" is not a weekday (mon, tue, wed, thu, fri, sat, sun)',
    );
    expect(errorsOf(edit("conditions.csv", 13, "value", "11|13"))).toContain(
      'conditions.csv row 13, column "value": "13" is not a month number (1 to 12)',
    );
  });

  it("a duplicate ruleId", () => {
    expect(errorsOf(edit("rules.csv", 3, "rule_id", "hall-weekday"))).toContain(
      'rules.csv row 3, column "rule_id": "hall-weekday" is already used on row 2',
    );
  });

  it("a missing required column", () => {
    const rows = parseCsv(files["rules.csv"] ?? "");
    const drop = (rows[0] ?? []).indexOf("label");
    const noLabel = toCsv(rows.map((r) => r.filter((_, i) => i !== drop)));
    expect(errorsOf({ ...files, "rules.csv": noLabel })).toContain('rules.csv row 1: missing column "label"');
  });

  it("a missing sheet", () => {
    const { "taxes.csv": _omit, ...rest } = files;
    expect(errorsOf(rest)).toContain("taxes.csv: file is missing from the template");
  });

  it("a whole-number cell that is not whole", () => {
    expect(errorsOf(edit("conditions.csv", 4, "to", "30x"))).toContain('conditions.csv row 4, column "to": "30x" is not a whole number');
  });

  it("a rule that points at a rule_id nobody defined", () => {
    expect(errorsOf(edit("conditions.csv", 2, "rule_id", "hall-weekdy"))).toContain(
      'conditions.csv row 2, column "rule_id": "hall-weekdy" is not a rule_id in rules.csv',
    );
  });

  it("an unknown charge type and a missing meta row", () => {
    expect(errorsOf(edit("rules.csv", 2, "charge", "magic"))).toContain(
      'rules.csv row 2, column "charge": "magic" is not a charge type (flat, per_unit, tiered, tiered_per_unit)',
    );
    const meta = parseCsv(files["meta.csv"] ?? "").filter((r) => r[0] !== "currency");
    expect(errorsOf({ ...files, "meta.csv": toCsv(meta) })).toContain('meta.csv: missing row "currency"');
  });

  it("reports every broken cell in one pass", () => {
    const f = { ...edit("rules.csv", 4, "price", "abc"), ...{ "conditions.csv": edit("conditions.csv", 3, "condition", "x")["conditions.csv"] as string } };
    expect(errorsOf(f)).toHaveLength(2);
  });

  it("a kernel-level problem is mapped back to its cell: a tax rate above 100%", () => {
    expect(errorsOf(edit("taxes.csv", 2, "rate_percent", "180"))).toEqual([
      'taxes.csv row 2, column "rate_percent": must be 0..10000 basis points',
    ]);
  });

  it("a kernel-level problem is mapped back to the sheet: no core rule at all", () => {
    let f = files;
    for (const row of [2, 3, 4, 5]) f = { ...f, ...edit2(f, "rules.csv", row, "core", "no") };
    const errs = errorsOf(f);
    expect(errs[0]).toMatch(/^rules\.csv: needs at least one core rule/);
  });
});

function edit2(base: TemplateFiles, file: string, row: number, column: string, value: string): TemplateFiles {
  const rows = parseCsv(base[file] ?? "");
  const col = (rows[0] ?? []).indexOf(column);
  (rows[row - 1] as string[])[col] = value;
  return { [file]: toCsv(rows) };
}
