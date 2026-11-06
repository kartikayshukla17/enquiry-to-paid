import type { ExtractInput, ExtractResult, LlmProvider, WordReplyInput, WordReplyResult } from "../types.js";

export const WEAK_MODEL_ID = "weak-fixture-v0";

/**
 * weak-fixture-v0: a DELIBERATELY WEAKER model, used to demonstrate the enablement gate blocking it.
 * It wraps another provider and, for any non-English message, misreads the code-switched hundreds ("do sau", "dedh sau")
 * as bare units, dropping the "sau". English answers pass through untouched, so the regression is language-specific.
 */
export function withWeakHinglishNumbers(inner: LlmProvider): LlmProvider {
  return {
    async extract(input: ExtractInput): Promise<ExtractResult> {
      const r = await inner.extract(input);
      const f = r.fields as Record<string, unknown> | null;
      const weakened =
        f && typeof f === "object" && f.language !== "en" && typeof f.guestCount === "number" && f.guestCount >= 100
          ? { ...f, guestCount: Math.max(1, Math.floor(f.guestCount / 100)) }
          : r.fields;
      return { ...r, modelId: WEAK_MODEL_ID, fields: weakened };
    },
    async wordReply(input: WordReplyInput): Promise<WordReplyResult> {
      return { ...(await inner.wordReply(input)), modelId: WEAK_MODEL_ID };
    },
  };
}

/** Same behaviour, different identity: stands in for a distinct model that happens to answer identically. */
export function withModelId(inner: LlmProvider, modelId: string): LlmProvider {
  return {
    async extract(input) {
      return { ...(await inner.extract(input)), modelId };
    },
    async wordReply(input) {
      return { ...(await inner.wordReply(input)), modelId };
    },
  };
}
