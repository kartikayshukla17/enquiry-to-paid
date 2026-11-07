import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { createReplayProvider } from "../llm/fixture/index.js";
import { DEFAULT_REGISTRY_PATH, loadRegistry } from "../llm/registry.js";
import type { ExtractInput, ExtractResult, LlmProvider } from "../llm/types.js";
import { DEFAULT_BASELINES_DIR, DEFAULT_RECORDINGS_DIR, loadSets } from "../eval/sets.js";
import { checkEnable, enableProvider, type GateDeps } from "./gate.js";
import { providerMain } from "./cli-main.js";
import { sha256 } from "../eval/sets.js";

let db: TestDb;
let tmp: string;
let deps: GateDeps;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "e2p-gate-"));
  await cp(DEFAULT_BASELINES_DIR, path.join(tmp, "baselines"), { recursive: true });
  await cp(DEFAULT_REGISTRY_PATH, path.join(tmp, "enabled-providers.json"));
  deps = { pool: db.pool, registryPath: path.join(tmp, "enabled-providers.json"), baselinesDir: path.join(tmp, "baselines") };
  return async () => {
    await rm(tmp, { recursive: true, force: true });
  };
});

describe("the committed registry", () => {
  it("lists the current model with the hash of the eval run that justified it", async () => {
    const reg = loadRegistry();
    const cur = reg.enabled[reg.current]!;
    expect(cur).toMatchObject({ provider: "fixture", model: "recorded-fixture-v1" });
    expect(cur.enabledAt).toBe(sha256(await readFile(path.join(DEFAULT_BASELINES_DIR, cur.baseline))));
  });
});

describe("checkEnable: weak model", () => {
  it("is BLOCKED, naming the language and the metric that regressed, and nothing is written", async () => {
    const r = await checkEnable("fixture", "weak-fixture-v0", deps);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/^BLOCKED: hinglish\.outcomeAccuracy \d+\.\d% < baseline \d+\.\d%$/m);
    expect(r.out).toMatch(/^BLOCKED: hindi\./m);
    expect(r.out).not.toMatch(/BLOCKED: english\./); // English is untouched by the weakness
    expect(r.regressions.some((x) => x.language === "hinglish" && x.metric === "outcomeAccuracy")).toBe(true);
    const r2 = await enableProvider("fixture", "weak-fixture-v0", deps);
    expect(r2.ok).toBe(false);
    expect(Object.keys(loadRegistry(deps.registryPath).enabled)).toEqual(["fixture/recorded-fixture-v1"]);
    expect(existsSync(path.join(tmp, "baselines", "weak-fixture-v0.09cc42a3.json"))).toBe(false);
  }, 30_000); // runs the full eval twice; slow under parallel load
});

describe("checkEnable: equal or better candidate", () => {
  it("an equal candidate passes, and enabling writes its own baseline and registry entry", async () => {
    const r = await enableProvider("fixture", "recorded-fixture-v1b", deps);
    expect(r.ok).toBe(true);
    expect(r.out).toContain("ENABLED fixture/recorded-fixture-v1b");
    const file = path.join(tmp, "baselines", "recorded-fixture-v1b.09cc42a3.json");
    expect(existsSync(file)).toBe(true);
    const reg = loadRegistry(deps.registryPath);
    expect(reg.enabled["fixture/recorded-fixture-v1b"]).toMatchObject({
      baseline: "recorded-fixture-v1b.09cc42a3.json",
      enabledAt: sha256(await readFile(file)),
    });
    expect(reg.current).toBe("fixture/recorded-fixture-v1"); // not promoted unless asked
  });

  it("a strictly better candidate (gold answers, confident) passes", async () => {
    const { cases } = await loadSets();
    const byText = new Map(cases.map((c) => [c.text.replace(/\s+/g, " ").trim(), c.gold]));
    const better: LlmProvider = {
      ...createReplayProvider(DEFAULT_RECORDINGS_DIR),
      async extract(i: ExtractInput): Promise<ExtractResult> {
        const gold = byText.get(i.text.replace(/\s+/g, " ").trim())!;
        return { modelId: "gold-v0", provider: "fixture", region: "local", usage: { tokens: 0 }, fields: { ...gold, confidenceBps: 9500, intent: "enquiry" } };
      },
    };
    const r = await checkEnable("fixture", "gold-v0", { ...deps, resolve: async () => better });
    expect(r.ok).toBe(true);
    expect(r.out).not.toContain("BLOCKED");
  });

  it("a candidate worse in a single metric of a single language is blocked even if better elsewhere", async () => {
    // recorded-fixture-v1 answers, except one English schema failure on top of the baseline's own
    const inner = createReplayProvider(DEFAULT_RECORDINGS_DIR);
    const worse: LlmProvider = {
      ...inner,
      async extract(i: ExtractInput) {
        const r = await inner.extract(i);
        return i.text.startsWith("Hi") ? { ...r, fields: { junk: true } } : r;
      },
    };
    const r = await checkEnable("fixture", "worse-v0", { ...deps, resolve: async () => worse });
    expect(r.ok).toBe(false);
    expect(r.regressions.every((x) => x.language === "english")).toBe(true);
    expect(r.out).toMatch(/BLOCKED: english\.schemaValidRate/);
  });

  it("promote makes the new model the reference for later candidates", async () => {
    await enableProvider("fixture", "recorded-fixture-v1b", { ...deps, promote: true });
    expect(loadRegistry(deps.registryPath).current).toBe("fixture/recorded-fixture-v1b");
  });

  it("refuses a provider/model with no offline eval path", async () => {
    await expect(checkEnable("groq", "llama-3.3-70b-versatile", deps)).rejects.toThrow(/no offline eval/);
  });
});

describe("pnpm provider (exit codes)", () => {
  const run = (argv: string[]) => providerMain(argv, deps);
  it("check: 1 when blocked, 0 when it passes, writes nothing", async () => {
    expect((await run(["check", "fixture", "weak-fixture-v0"])).code).toBe(1);
    const ok = await run(["check", "fixture", "recorded-fixture-v1b"]);
    expect(ok.code).toBe(0);
    expect(existsSync(path.join(tmp, "baselines", "recorded-fixture-v1b.09cc42a3.json"))).toBe(false);
  });
  it("enable: 1 when blocked, 0 when enabled; 2 on bad usage", async () => {
    const blocked = await run(["enable", "fixture", "weak-fixture-v0"]);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toContain("BLOCKED: hinglish.outcomeAccuracy");
    expect((await run(["enable", "fixture", "recorded-fixture-v1b"])).code).toBe(0);
    expect((await run(["enable", "fixture"])).code).toBe(2);
    expect((await run(["nonsense"])).code).toBe(2);
    expect((await run(["check", "groq", "x"])).code).toBe(2);
  });
  it("after enabling, the runtime guard accepts the model", async () => {
    const { createProvider } = await import("../llm/config.js");
    expect(() => createProvider({ LLM_PROVIDER: "fixture", LLM_MODEL: "recorded-fixture-v1b" }, { registry: loadRegistry(deps.registryPath) })).toThrow(/not enabled/);
    await run(["enable", "fixture", "recorded-fixture-v1b"]);
    expect(() => createProvider({ LLM_PROVIDER: "fixture", LLM_MODEL: "recorded-fixture-v1b" }, { registry: loadRegistry(deps.registryPath) })).not.toThrow();
  });
});
