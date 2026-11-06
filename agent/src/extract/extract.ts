import { LlmError, type CallMeta, type LlmProvider } from "../llm/types.js";
import { SCHEMA_VERSION } from "../llm/prompts.js";
import type { ExtractedFields } from "../kernel/types.js";
import { validateExtraction } from "./schema.js";

export type Extraction =
  | { ok: true; fields: ExtractedFields; meta: CallMeta }
  | {
      ok: false;
      /** provider_error | timeout | rate_limited | malformed_response | schema_invalid */
      failure: string;
      detail: string;
      /** Present when a call completed (so it cost money and a provider saw the text). */
      meta?: CallMeta;
      /** Which provider was tried, when the call itself failed. */
      attempt?: Partial<CallMeta>;
    };

/**
 * Extraction through the provider seam. Never throws for provider trouble or bad output: those become a
 * typed failure the pipeline turns into a holding reply. Configuration/replay errors (missing recording,
 * missing key) do throw: they are bugs in setup, not provider failures, and must be loud.
 */
export async function extractFields(llm: LlmProvider, text: string): Promise<Extraction> {
  let res;
  try {
    res = await llm.extract({ text, schemaVersion: SCHEMA_VERSION });
  } catch (e) {
    if (e instanceof LlmError && e.code !== "missing_recording" && e.code !== "not_configured") {
      return { ok: false, failure: e.code === "http_error" ? "provider_error" : e.code, detail: e.message, ...(e.attempt && { attempt: e.attempt }) };
    }
    if (e instanceof LlmError) throw e;
    return { ok: false, failure: "provider_error", detail: "unexpected provider failure" };
  }
  const { fields: raw, ...meta } = res;
  const v = validateExtraction(raw);
  if (!v.ok) return { ok: false, failure: "schema_invalid", detail: v.error, meta };
  return { ok: true, fields: v.fields, meta };
}
