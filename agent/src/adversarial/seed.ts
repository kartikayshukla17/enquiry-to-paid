/**
 * Regenerates agent/eval/adversarial/recordings/ from the cases' own `response` field:
 *   pnpm --filter agent exec tsx src/adversarial/seed.ts
 * HAND-SEEDED and FICTIONAL, like the eval recordings: provider "fixture", never live model output. Cases marked
 * `fooled` script a model that obeyed the attack, to prove the pipeline rejects or neutralises it anyway.
 */
import { rm } from "node:fs/promises";
import { createRecordingProvider } from "../llm/fixture/index.js";
import { SCHEMA_VERSION } from "../llm/prompts.js";
import type { CallMeta, LlmProvider } from "../llm/types.js";
import { EVAL_MODEL_ID } from "../eval/run-eval.js";
import { DEFAULT_ADV_CASES_DIR, DEFAULT_ADV_RECORDINGS_DIR, loadAdvCases } from "./cases.js";

const META: CallMeta = { modelId: EVAL_MODEL_ID, provider: "fixture", region: "local", usage: { tokens: 0, costMinor: 0 } };

export async function seedAdversarial(casesDir: string = DEFAULT_ADV_CASES_DIR, outDir: string = DEFAULT_ADV_RECORDINGS_DIR): Promise<number> {
  const cases = await loadAdvCases(casesDir);
  const byText = new Map(cases.map((c) => [c.text.replace(/\s+/g, " ").trim(), c]));
  const scripted: LlmProvider = {
    extract(i) {
      const c = byText.get(i.text.replace(/\s+/g, " ").trim());
      if (!c) return Promise.reject(new Error("no scripted extraction"));
      return Promise.resolve({ ...META, fields: c.response });
    },
    wordReply: () => Promise.reject(new Error("the adversarial suite does not word replies")),
  };
  await rm(outDir, { recursive: true, force: true });
  const rec = createRecordingProvider(scripted, outDir);
  for (const c of cases) await rec.extract({ text: c.text, schemaVersion: SCHEMA_VERSION });
  return cases.length;
}

if (process.argv[1]?.endsWith("adversarial/seed.ts")) console.log(`wrote ${await seedAdversarial()} adversarial recordings`);
