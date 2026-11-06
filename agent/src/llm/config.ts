import { fileURLToPath } from "node:url";
import { createRecordingProvider, createReplayProvider } from "./fixture/index.js";
import { createGroqProvider } from "./groq/index.js";
import { LlmError, type LlmProvider } from "./types.js";

export const DEFAULT_RECORDINGS_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

export interface ProviderOverrides {
  recordingsDir?: string;
  /** Test hook: stands in for the Groq adapter. */
  liveProvider?: LlmProvider;
  fetch?: typeof fetch;
}

type Env = Record<string, string | undefined>;

/**
 * Provider selection is configuration only:
 *   LLM_PROVIDER=groq|fixture   (default fixture)
 *   LLM_MODE=record|replay|live (default replay; tests and CI never leave replay)
 */
export function createProvider(env: Env = process.env, o: ProviderOverrides = {}): LlmProvider {
  const name = env.LLM_PROVIDER ?? "fixture";
  const mode = env.LLM_MODE ?? "replay";
  if (name !== "groq" && name !== "fixture") throw new Error(`LLM_PROVIDER must be groq or fixture, got "${name}"`);
  if (mode !== "record" && mode !== "replay" && mode !== "live") throw new Error(`LLM_MODE must be record, replay or live, got "${mode}"`);
  const dir = o.recordingsDir ?? DEFAULT_RECORDINGS_DIR;

  if (mode === "replay") return createReplayProvider(dir); // the provider name only matters when a call is made live
  if (name === "fixture") throw new LlmError("not_configured", `LLM_MODE=${mode} needs LLM_PROVIDER=groq; the fixture provider only replays`);

  const live =
    o.liveProvider ??
    (() => {
      if (!env.GROQ_API_KEY) throw new LlmError("not_configured", "GROQ_API_KEY is required for LLM_PROVIDER=groq with LLM_MODE=record|live");
      return createGroqProvider({
        apiKey: env.GROQ_API_KEY,
        ...(env.GROQ_MODEL && { model: env.GROQ_MODEL }),
        ...(env.GROQ_REGION && { region: env.GROQ_REGION }),
        ...(o.fetch && { fetch: o.fetch }),
      });
    })();
  return mode === "record" ? createRecordingProvider(live, dir) : live;
}
