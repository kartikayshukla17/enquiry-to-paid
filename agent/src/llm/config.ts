import { fileURLToPath } from "node:url";
import { createRecordingProvider, createReplayProvider } from "./fixture/index.js";
import { createGroqProvider, DEFAULT_GROQ_MODEL } from "./groq/index.js";
import { createKeywordProvider, KEYWORD_MODEL_ID } from "./providers/keyword.js";
import { WEAK_MODEL_ID, withModelId, withWeakHinglishNumbers } from "./providers/weak.js";
import { assertEnabled, loadRegistry, type Registry } from "./registry.js";
import { LlmError, type LlmProvider } from "./types.js";

export const DEFAULT_RECORDINGS_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const FIXTURE_MODEL_ID = "recorded-fixture-v1";
/** Replays the same recordings under a second identity: the "equal model" used to show the gate passing. */
export const FIXTURE_ALIAS_MODEL_ID = "recorded-fixture-v1b";

export interface ProviderOverrides {
  recordingsDir?: string;
  /** Test hook: stands in for the Groq adapter. */
  liveProvider?: LlmProvider;
  fetch?: typeof fetch;
  /**
   * The enabled-provider registry the runtime guard checks. Default: agent/config/enabled-providers.json.
   * `false` skips the guard (tests and the eval harness only; it is never reachable from env).
   */
  registry?: Registry | false;
}

type Env = Record<string, string | undefined>;

const PROVIDERS = ["groq", "fixture", "keyword"] as const;

/**
 * Provider selection is configuration only:
 *   LLM_PROVIDER=groq|fixture|keyword   (default fixture)
 *   LLM_MODEL=<model>                   (fixture: recorded-fixture-v1 | recorded-fixture-v1b | weak-fixture-v0; keyword: keyword-extractor-v0; groq: any, falls back to GROQ_MODEL)
 *   LLM_MODE=record|replay|live         (default replay; tests and CI never leave replay)
 * Unless `registry: false`, the provider/model must be in agent/config/enabled-providers.json (record mode is dev tooling and exempt).
 */
export function createProvider(env: Env = process.env, o: ProviderOverrides = {}): LlmProvider {
  const name = env.LLM_PROVIDER ?? "fixture";
  const mode = env.LLM_MODE ?? "replay";
  if (!(PROVIDERS as readonly string[]).includes(name)) throw new Error(`LLM_PROVIDER must be groq, fixture or keyword, got "${name}"`);
  if (mode !== "record" && mode !== "replay" && mode !== "live") throw new Error(`LLM_MODE must be record, replay or live, got "${mode}"`);
  const dir = o.recordingsDir ?? DEFAULT_RECORDINGS_DIR;
  const defaultModel = name === "fixture" ? FIXTURE_MODEL_ID : name === "keyword" ? KEYWORD_MODEL_ID : (env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL);
  const model = env.LLM_MODEL ?? defaultModel;

  if (name === "fixture" && ![FIXTURE_MODEL_ID, FIXTURE_ALIAS_MODEL_ID, WEAK_MODEL_ID].includes(model)) throw new Error(`LLM_MODEL "${model}" is not a fixture model`);
  if (name === "keyword" && model !== KEYWORD_MODEL_ID) throw new Error(`LLM_MODEL "${model}" is not a keyword model`);
  if (mode !== "record" && o.registry !== false) assertEnabled(name, model, o.registry ?? loadRegistry());

  if (name === "keyword") return createKeywordProvider();
  if (mode === "replay") {
    const replay = createReplayProvider(dir); // for groq the name only matters when a call is made live
    if (name !== "fixture") return replay;
    return model === WEAK_MODEL_ID ? withWeakHinglishNumbers(replay) : model === FIXTURE_ALIAS_MODEL_ID ? withModelId(replay, model) : replay;
  }
  if (name === "fixture") throw new LlmError("not_configured", `LLM_MODE=${mode} needs LLM_PROVIDER=groq; the fixture provider only replays`);

  const live =
    o.liveProvider ??
    (() => {
      if (!env.GROQ_API_KEY) throw new LlmError("not_configured", "GROQ_API_KEY is required for LLM_PROVIDER=groq with LLM_MODE=record|live");
      return createGroqProvider({
        apiKey: env.GROQ_API_KEY,
        model,
        ...(env.GROQ_REGION && { region: env.GROQ_REGION }),
        ...(o.fetch && { fetch: o.fetch }),
      });
    })();
  return mode === "record" ? createRecordingProvider(live, dir) : live;
}
