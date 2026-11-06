/** Swappable LLM seam (PRD US8). The model only ever sees customer text and returns untrusted data. */
export interface Usage {
  /** Total tokens for the call. */
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Integer minor units (paise), rounded up so a call is never under-reported. */
  costMinor?: number;
}

export interface CallMeta {
  modelId: string;
  provider: string;
  /** Where the customer text was processed (residency record). */
  region: string;
  usage: Usage;
}

export interface ExtractInput {
  text: string;
  schemaVersion: string;
}
export interface ExtractResult extends CallMeta {
  /** Unvalidated JSON exactly as the model produced it. */
  fields: unknown;
}

export type ReplyKind = "quote" | "clarify" | "holding";
export interface WordReplyInput {
  kind: ReplyKind;
  /** Reply wording with `{{placeholders}}`. Numbers are injected by code after the model is done. */
  template: string;
}
export interface WordReplyResult extends CallMeta {
  /** Reworded template; must keep every placeholder. */
  text: string;
}

export interface LlmProvider {
  extract(input: ExtractInput): Promise<ExtractResult>;
  wordReply(input: WordReplyInput): Promise<WordReplyResult>;
}

export type LlmErrorCode = "http_error" | "rate_limited" | "timeout" | "malformed_response" | "missing_recording" | "not_configured";

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
