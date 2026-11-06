/**
 * Regenerates agent/eval/recordings/ from the labelled sets + ./recorded.ts:
 *   pnpm --filter agent exec tsx src/eval/seed.ts
 * Recordings are keyed by sha256(op, text, prompt hash), so editing the extraction prompt invalidates them on purpose.
 * They are labelled provider "fixture" / model "recorded-fixture-v1": hand-seeded, never live model output.
 */
import { rm } from "node:fs/promises";
import { createRecordingProvider } from "../llm/fixture/index.js";
import { SCHEMA_VERSION } from "../llm/prompts.js";
import type { CallMeta, LlmProvider } from "../llm/types.js";
import { recordedResponse } from "./recorded.js";
import { DEFAULT_RECORDINGS_DIR, DEFAULT_SETS_DIR, loadSets } from "./sets.js";

import { EVAL_MODEL_ID } from "./run-eval.js";
const META: CallMeta = { modelId: EVAL_MODEL_ID, provider: "fixture", region: "local", usage: { tokens: 0, costMinor: 0 } };

export async function seedRecordings(setsDir: string = DEFAULT_SETS_DIR, outDir: string = DEFAULT_RECORDINGS_DIR): Promise<number> {
  const { cases } = await loadSets(setsDir);
  const byText = new Map(cases.map((c) => [c.text.replace(/\s+/g, " ").trim(), c]));
  const scripted: LlmProvider = {
    extract(i) {
      const c = byText.get(i.text.replace(/\s+/g, " ").trim());
      if (!c) return Promise.reject(new Error("no scripted extraction"));
      return Promise.resolve({ ...META, fields: recordedResponse(c) });
    },
    wordReply: () => Promise.reject(new Error("eval does not word replies")),
  };
  await rm(outDir, { recursive: true, force: true });
  const rec = createRecordingProvider(scripted, outDir);
  for (const c of cases) await rec.extract({ text: c.text, schemaVersion: SCHEMA_VERSION });
  return cases.length;
}

if (process.argv[1]?.endsWith("seed.ts")) console.log(`wrote ${await seedRecordings()} eval recordings`);
