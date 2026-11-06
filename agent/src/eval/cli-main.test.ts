import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { evalMain, type EvalPaths } from "./cli-main.js";
import { DEFAULT_RECORDINGS_DIR } from "./sets.js";
import { EXTRACT_PROMPT_HASH } from "../llm/prompts.js";

let db: TestDb;
let tmp: string;
let paths: EvalPaths;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "e2p-eval-"));
  await cp(DEFAULT_RECORDINGS_DIR, path.join(tmp, "recordings"), { recursive: true });
  paths = { baselinesDir: path.join(tmp, "baselines"), resultsPath: path.join(tmp, "RESULTS.md"), recordingsDir: path.join(tmp, "recordings") };
  return async () => {
    await rm(tmp, { recursive: true, force: true });
  };
});

const run = (argv: string[]) => evalMain(argv, { pool: db.pool, ...paths });
const baselineFiles = async () => (existsSync(paths.baselinesDir!) ? readdir(paths.baselinesDir!) : []);
const baselinePath = async () => path.join(paths.baselinesDir!, (await baselineFiles())[0]!);

describe("pnpm eval", () => {
  it("prints a per-language table, labelled as fictional data from a recorded fixture, and writes both files", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    for (const lang of ["en", "hinglish", "hi", "ALL"]) expect(r.out).toMatch(new RegExp(`^${lang}\\s`, "m"));
    for (const col of ["field acc", "schema-valid", "mean conf", "outcome acc", "UNSAFE QUOTES"]) expect(r.out).toContain(col);
    expect(r.out).toContain("measured on fictional data; recorded-fixture provider, not a live model");
    expect(r.out).toMatch(/NOT a measurement of any model/);
    expect(r.out).toMatch(/unsafe quotes issued: \d+/i);

    expect(await baselineFiles()).toEqual([`recorded-fixture-v1.${EXTRACT_PROMPT_HASH.slice(0, 8)}.json`]);
    const baseline = JSON.parse(await readFile(await baselinePath(), "utf8"));
    expect(baseline.provenance.label).toBe("measured on fictional data; recorded-fixture provider, not a live model");
    expect(Object.keys(baseline.languages)).toEqual(["en", "hinglish", "hi"]);
    expect(Object.keys(baseline.inputs.setHashes).sort()).toEqual(["b2b.jsonl", "en.jsonl", "hinglish.jsonl", "photographer.jsonl"]);

    const md = await readFile(paths.resultsPath!, "utf8");
    expect(md).toContain("measured on fictional data; recorded-fixture provider, not a live model");
    expect(md).toMatch(/not (a )?(measure|model accuracy)/i);
    expect(md).toContain("Unsafe quotes");
    expect(md).toContain("Results per rate card");
    expect(md).toContain("`fictional-photographer`");
    expect(r.out).toMatch(/fictional-photographer\s+14/);
    expect(md).toContain("en-09"); // bad numbers are named, not hidden
  });

  it("is reproducible: a second run produces byte-identical output, baseline and results", async () => {
    const a = await run(["--write-baseline"]);
    const files1 = [await readFile(await baselinePath()), await readFile(paths.resultsPath!)];
    const b = await run(["--write-baseline"]);
    const files2 = [await readFile(await baselinePath()), await readFile(paths.resultsPath!)];
    expect(b.out).toBe(a.out);
    expect(files2[0]!.equals(files1[0]!)).toBe(true);
    expect(files2[1]!.equals(files1[1]!)).toBe(true);
    expect(files1[1]!.toString()).not.toMatch(/generated at|Date\.now/i);
  });

  it("does not overwrite an existing baseline unless --write-baseline is given", async () => {
    await run([]);
    const p = await baselinePath();
    await writeFile(p, "{}\n");
    await run([]);
    expect(await readFile(p, "utf8")).toBe("{}\n");
    await run(["--write-baseline"]);
    expect(await readFile(p, "utf8")).not.toBe("{}\n");
  });
});

describe("pnpm eval --check", () => {
  it("passes against a freshly written baseline and writes nothing itself", async () => {
    await run(["--write-baseline"]);
    const before = await readFile(paths.resultsPath!, "utf8");
    const r = await run(["--check"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/check: OK/);
    expect(await readFile(paths.resultsPath!, "utf8")).toBe(before);
  });

  it("fails when there is no baseline for this model + prompt hash", async () => {
    const r = await run(["--check"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/no baseline/i);
  });

  it("fails, naming the language and metric, when a recording is altered", async () => {
    await run(["--write-baseline"]);
    // Corrupt one recorded Hinglish extraction: now a different date.
    const files = await readdir(paths.recordingsDir!);
    let altered = "";
    for (const f of files) {
      const p = path.join(paths.recordingsDir!, f);
      const rec = JSON.parse(await readFile(p, "utf8"));
      if (rec.input.text.startsWith("Bhaiya 12 December 2026")) {
        rec.response.fields.date = "2026-12-14";
        await writeFile(p, `${JSON.stringify(rec, null, 2)}\n`);
        altered = f;
      }
    }
    expect(altered).not.toBe("");
    const r = await run(["--check"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("DRIFT");
    expect(r.out).toContain("languages.hinglish.extraction.fieldsCorrect");
    expect(r.out).toContain("inputs.recordingsHash");
  });

  it("fails on a recording edit that changes no metric (the recordings hash still moves)", async () => {
    await run(["--write-baseline"]);
    const f = (await readdir(paths.recordingsDir!))[0]!;
    const p = path.join(paths.recordingsDir!, f);
    const rec = JSON.parse(await readFile(p, "utf8"));
    rec.response.region = "elsewhere";
    await writeFile(p, `${JSON.stringify(rec, null, 2)}\n`);
    const r = await run(["--check"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("inputs.recordingsHash");
  });

  it("fails when the published RESULTS.md was hand-edited", async () => {
    await run(["--write-baseline"]);
    await writeFile(paths.resultsPath!, `${await readFile(paths.resultsPath!, "utf8")}\nfake: 100% accurate in Hinglish\n`);
    const r = await run(["--check"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/RESULTS\.md/);
  });
});

describe("committed artifacts", () => {
  it("the committed baseline and RESULTS.md match what the committed sets and recordings produce (what CI runs)", async () => {
    const r = await evalMain(["--check"], { pool: db.pool });
    expect(r.out).toMatch(/check: OK/);
    expect(r.code).toBe(0);
  });
});
