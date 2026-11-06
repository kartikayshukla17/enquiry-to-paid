import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProvider } from "../config.js";
import { LlmError, type LlmProvider } from "../types.js";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(path.join(tmpdir(), "e2p-rec-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const liveStub = (): { provider: LlmProvider; calls: number[] } => {
  const calls: number[] = [];
  const meta = { modelId: "stub-model", provider: "groq", region: "us", usage: { tokens: 10, costMinor: 1 } };
  return {
    calls,
    provider: {
      extract: (i) => {
        calls.push(1);
        return Promise.resolve({ ...meta, fields: { echo: i.text } });
      },
      wordReply: (i) => {
        calls.push(1);
        return Promise.resolve({ ...meta, text: i.template });
      },
    },
  };
};

describe("recorded-fixture provider", () => {
  it("record mode calls the live provider and writes a recording; replay reproduces it offline", async () => {
    const dir = await tmp();
    const live = liveStub();
    const rec = createProvider({ LLM_PROVIDER: "groq", LLM_MODE: "record" }, { recordingsDir: dir, liveProvider: live.provider });
    const a = await rec.extract({ text: "Need hall for 50 people", schemaVersion: "extract-v1" });
    expect(live.calls).toHaveLength(1);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);

    const replay = createProvider({ LLM_PROVIDER: "fixture" }, { recordingsDir: dir }); // replay is the default mode
    const b = await replay.extract({ text: "  Need hall   for 50 people ", schemaVersion: "extract-v1" }); // normalised input
    expect(b).toEqual(a);
    expect(live.calls).toHaveLength(1);
  });

  it("a missing recording in replay mode fails loudly and names the key", async () => {
    const replay = createProvider({ LLM_PROVIDER: "fixture", LLM_MODE: "replay" }, { recordingsDir: await tmp() });
    const err = await replay.extract({ text: "never recorded", schemaVersion: "extract-v1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe("missing_recording");
    expect((err as LlmError).message).toMatch(/[0-9a-f]{64}/);
    expect((err as LlmError).message).toMatch(/LLM_MODE=record/);
  });

  it("different ops and different input never share a recording", async () => {
    const dir = await tmp();
    const rec = createProvider({ LLM_PROVIDER: "groq", LLM_MODE: "record" }, { recordingsDir: dir, liveProvider: liveStub().provider });
    await rec.extract({ text: "same", schemaVersion: "extract-v1" });
    await rec.wordReply({ kind: "quote", template: "same" });
    await rec.extract({ text: "other", schemaVersion: "extract-v1" });
    expect(await readdir(dir)).toHaveLength(3);
  });

  it("recordings carry the op, normalised input and prompt hash for review, but no secrets", async () => {
    const dir = await tmp();
    const rec = createProvider({ LLM_PROVIDER: "groq", LLM_MODE: "record", GROQ_API_KEY: "k-123" }, { recordingsDir: dir, liveProvider: liveStub().provider });
    await rec.extract({ text: "hi", schemaVersion: "extract-v1" });
    const text = await readFile(path.join(dir, (await readdir(dir))[0] as string), "utf8");
    expect(JSON.parse(text)).toMatchObject({ op: "extract", input: { text: "hi" } });
    expect(JSON.parse(text).promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(text).not.toContain("k-123");
  });

  it("selection is config only: unknown provider, fixture+live, and groq without key are rejected", () => {
    expect(() => createProvider({ LLM_PROVIDER: "nope" })).toThrow(/LLM_PROVIDER/);
    expect(() => createProvider({ LLM_PROVIDER: "fixture", LLM_MODE: "live" })).toThrow(LlmError);
    expect(() => createProvider({ LLM_PROVIDER: "fixture", LLM_MODE: "record" })).toThrow(LlmError);
    expect(() => createProvider({ LLM_PROVIDER: "groq", LLM_MODE: "live" }, { registry: false })).toThrow(/GROQ_API_KEY/);
    expect(() => createProvider({ LLM_MODE: "sometimes" })).toThrow(/LLM_MODE/);
  });

  it("groq in live mode uses the live provider directly", async () => {
    const live = liveStub();
    const p = createProvider({ LLM_PROVIDER: "groq", LLM_MODE: "live" }, { liveProvider: live.provider, registry: false });
    await p.extract({ text: "x", schemaVersion: "extract-v1" });
    expect(live.calls).toHaveLength(1);
  });
});
