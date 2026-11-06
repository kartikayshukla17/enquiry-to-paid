import { EXTRACT_SYSTEM_PROMPT, WORD_SYSTEM_PROMPT, wrapCustomerText } from "../prompts.js";
import { LlmError, type LlmErrorCode, type CallMeta, type ExtractInput, type ExtractResult, type LlmProvider, type WordReplyInput, type WordReplyResult } from "../types.js";

export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
/** Current Groq production model at time of writing; override with GROQ_MODEL. */
export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

export interface GroqOptions {
  apiKey: string;
  model?: string;
  /** Recorded as the processing region. Groq does not expose it per call, so this is configuration. */
  region?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Paise per million tokens (integers). Defaults approximate list price; set to your invoice. */
  inputPaisePerMTok?: number;
  outputPaisePerMTok?: number;
}

interface ChatResponse {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

export function createGroqProvider(opts: GroqOptions): LlmProvider {
  if (!opts.apiKey) throw new LlmError("not_configured", "GROQ_API_KEY is not set");
  const model = opts.model ?? DEFAULT_GROQ_MODEL;
  const region = opts.region ?? "us";
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const fail = (code: LlmErrorCode, msg: string) => new LlmError(code, msg, { modelId: model, provider: "groq", region });
  const inRate = opts.inputPaisePerMTok ?? 5_300;
  const outRate = opts.outputPaisePerMTok ?? 7_100;

  async function chat(messages: { role: string; content: string }[], json: boolean): Promise<{ content: string; meta: CallMeta }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(GROQ_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, temperature: 0, ...(json && { response_format: { type: "json_object" } }) }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw fail("timeout", `groq call exceeded ${timeoutMs}ms`);
      throw fail("http_error", "groq network failure");
    } finally {
      clearTimeout(timer);
    }
    // Error bodies can echo the request; never copy them into the error.
    if (res.status === 429) throw fail("rate_limited", "groq rate limited (429)");
    if (!res.ok) throw fail("http_error", `groq http ${res.status}`);
    let data: ChatResponse;
    try {
      data = (await res.json()) as ChatResponse;
    } catch {
      throw fail("malformed_response", "groq response was not JSON");
    }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw fail("malformed_response", "groq response had no message content");
    const inputTokens = num(data.usage?.prompt_tokens);
    const outputTokens = num(data.usage?.completion_tokens);
    const tokens = num(data.usage?.total_tokens) || inputTokens + outputTokens;
    const costMinor = Math.ceil((inputTokens * inRate + outputTokens * outRate) / 1_000_000);
    return { content, meta: { modelId: model, provider: "groq", region, usage: { tokens, inputTokens, outputTokens, costMinor } } };
  }

  return {
    async extract(input: ExtractInput): Promise<ExtractResult> {
      const { content, meta } = await chat(
        [
          { role: "system", content: EXTRACT_SYSTEM_PROMPT },
          { role: "user", content: wrapCustomerText(input.text) },
        ],
        true,
      );
      let fields: unknown;
      try {
        fields = JSON.parse(content);
      } catch {
        throw fail("malformed_response", "model output was not valid JSON");
      }
      return { ...meta, fields };
    },
    async wordReply(input: WordReplyInput): Promise<WordReplyResult> {
      const { content, meta } = await chat(
        [
          { role: "system", content: WORD_SYSTEM_PROMPT },
          { role: "user", content: `Reply kind: ${input.kind}\nReply to reword:\n${input.template}` },
        ],
        false,
      );
      return { ...meta, text: content.trim() };
    },
  };
}
