import { fillTemplate } from "../pipeline/reply.js";
import type { Provenance } from "../pipeline/handle-enquiry.js";
import { LlmError, type LlmProvider, type ReplyKind } from "./types.js";

export interface WordedReply {
  reply: string;
  /** Present when an LLM call was made (even if its wording was then rejected): that call cost money. */
  provenance?: Provenance;
  /** Why the plain template reply was used instead of the LLM wording. */
  fallback?: "provider_error" | "placeholder_mismatch" | "stray_number";
}

export type ReplyWorder = (kind: ReplyKind, template: string, values: Record<string, string>) => Promise<WordedReply>;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const NUMBER_WORDS = /\b(hundred|thousand|lakh|lakhs|crore|crores|million|billion)\b/gi;

const placeholdersOf = (s: string): string[] => [...s.matchAll(PLACEHOLDER)].map((m) => m[1] as string).sort();
const digitRuns = (s: string): Set<string> => new Set(s.match(/\d+/g) ?? []);
const numberWords = (s: string): Set<string> => new Set((s.match(NUMBER_WORDS) ?? []).map((w) => w.toLowerCase()));

/**
 * Lets the model reword a template, then code takes over: the model never writes a number. Numbers are
 * injected from `values` after the model returns, and the final reply is checked against the plain
 * (kernel-derived) reply: any digit run or number word it cannot find there forces the plain reply.
 */
export function makeReplyWorder(llm: LlmProvider): ReplyWorder {
  return async (kind, template, values) => {
    const plain = fillTemplate(template, values);
    let res;
    try {
      res = await llm.wordReply({ kind, template });
    } catch (e) {
      if (e instanceof LlmError && (e.code === "missing_recording" || e.code === "not_configured")) throw e;
      return { reply: plain, fallback: "provider_error" };
    }
    const provenance: Provenance = {
      modelId: res.modelId,
      provider: res.provider,
      region: res.region,
      costMinor: res.usage.costMinor ?? 0,
    };
    // Every placeholder exactly once, nothing invented.
    if (placeholdersOf(res.text).join() !== placeholdersOf(template).join()) {
      return { reply: plain, provenance, fallback: "placeholder_mismatch" };
    }
    const final = fillTemplate(res.text, values);
    const allowedDigits = digitRuns(plain);
    const allowedWords = numberWords(plain);
    for (const d of digitRuns(final)) if (!allowedDigits.has(d)) return { reply: plain, provenance, fallback: "stray_number" };
    for (const w of numberWords(final)) if (!allowedWords.has(w)) return { reply: plain, provenance, fallback: "stray_number" };
    return { reply: final, provenance };
  };
}
