import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LlmError } from "./types.js";

export const DEFAULT_REGISTRY_PATH = path.join(fileURLToPath(new URL("../../", import.meta.url)), "config", "enabled-providers.json");

export interface EnabledEntry {
  provider: string;
  model: string;
  /** Extraction prompt hash (8 hex) the baseline was measured with. */
  promptHash8: string;
  /** Baseline file name under agent/eval/baselines/. */
  baseline: string;
  /** sha256 of that baseline file's bytes: the eval run that justified enabling. */
  enabledAt: string;
}

export interface Registry {
  /** `provider/model` key whose baseline every candidate is compared against. */
  current: string;
  enabled: Record<string, EnabledEntry>;
}

export const registryKey = (provider: string, model: string): string => `${provider}/${model}`;

export function loadRegistry(file: string = DEFAULT_REGISTRY_PATH): Registry {
  return JSON.parse(readFileSync(file, "utf8")) as Registry;
}

/** Runtime guard: a provider/model that has not passed the gate must not handle customer text. */
export function assertEnabled(provider: string, model: string, registry: Registry): void {
  if (!registry.enabled[registryKey(provider, model)]) {
    throw new LlmError(
      "not_configured",
      `provider/model ${registryKey(provider, model)} is not enabled; run \`pnpm provider enable ${provider} ${model}\` (it must meet the recorded baseline in every language)`,
    );
  }
}
