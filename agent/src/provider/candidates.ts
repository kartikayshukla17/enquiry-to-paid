import { createReplayProvider } from "../llm/fixture/index.js";
import { createKeywordProvider, KEYWORD_MODEL_ID } from "../llm/providers/keyword.js";
import { WEAK_MODEL_ID, withModelId, withWeakHinglishNumbers } from "../llm/providers/weak.js";
import { FIXTURE_ALIAS_MODEL_ID, FIXTURE_MODEL_ID } from "../llm/config.js";
import { LlmError, type LlmProvider } from "../llm/types.js";
import { DEFAULT_RECORDINGS_DIR } from "../eval/sets.js";

/**
 * How the gate obtains a candidate to evaluate OFFLINE. Fixture-backed and rule-based candidates replay or run
 * locally; a live provider (groq) cannot be scored without a network run, so it has no offline path and cannot be
 * enabled until its recorded responses for the eval sets exist.
 */
export const KNOWN_CANDIDATES: readonly string[] = [
  `fixture/${FIXTURE_MODEL_ID}`,
  `fixture/${FIXTURE_ALIAS_MODEL_ID}`,
  `fixture/${WEAK_MODEL_ID}`,
  `keyword/${KEYWORD_MODEL_ID}`,
];

export async function resolveCandidate(provider: string, model: string, recordingsDir: string = DEFAULT_RECORDINGS_DIR): Promise<LlmProvider> {
  const replay = () => createReplayProvider(recordingsDir);
  switch (`${provider}/${model}`) {
    case `fixture/${FIXTURE_MODEL_ID}`:
      return replay();
    case `fixture/${FIXTURE_ALIAS_MODEL_ID}`:
      return withModelId(replay(), model);
    case `fixture/${WEAK_MODEL_ID}`:
      return withWeakHinglishNumbers(replay());
    case `keyword/${KEYWORD_MODEL_ID}`:
      return createKeywordProvider();
    default:
      throw new LlmError(
        "not_configured",
        `no offline eval path for ${provider}/${model} (known: ${KNOWN_CANDIDATES.join(", ")}); a live model needs recorded responses for the eval sets first`,
      );
  }
}
