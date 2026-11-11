/**
 * Global, free, non-tenant ceiling on real Groq network calls (V10). Every playground tenant shares one Groq
 * API key, so this is account-wide, not per-tenant: a request ceiling, not a spend cap (Groq's free tier
 * cannot auto-bill, so there is no "spend" to cap).
 *
 * The default (`DEFAULT_GROQ_DAILY_CEILING`, 950) is a safety margin under the real, documented free-tier
 * "Developer" base limit for `openai/gpt-oss-120b` (this repo's configured `GROQ_MODEL`, per
 * `agent/.env.example`): **1,000 requests/day (RPD)**, read directly from Groq's own
 * https://console.groq.com/docs/rate-limits rate-limits table on 2026-11-11 (not copied from a third-party
 * blog). Re-verify against the account's actual Limits page before any real deployment goes live with
 * `LLM_PROVIDER=groq`: account-level limits can differ from the published base table, per Groq's own docs.
 *
 * This is a REQUEST ceiling, not an ENQUIRY ceiling: a single customer enquiry can cost up to 2 real Groq
 * calls (extract, then wordReply — two separate network calls against the same account-wide quota), so 950
 * RPD is roughly ~475 enquiries/day worst case, not 950.
 */
import type { Pool } from "pg";
import { LlmError, type ExtractInput, type ExtractResult, type LlmProvider, type WordReplyInput, type WordReplyResult } from "./types.js";

export const DEFAULT_GROQ_DAILY_CEILING = 950;

export type GroqUsageResult = { ok: true } | { ok: false; reason: "ceiling_reached" };

/**
 * Atomic check-and-increment for today's global Groq usage row: an upsert that only increments while under
 * the ceiling, so concurrent callers at the boundary can never push the stored count past it. Same pattern
 * (and same atomicity guarantee) as `simulator/playground.ts`'s `checkAndBumpUsage`, keyed by `day` alone
 * instead of `(ip_hash, day)` — this is the global, not-per-visitor cousin of that cap.
 */
export async function checkAndBumpGroqUsage(pool: Pool, day: string, ceiling: number): Promise<GroqUsageResult> {
  const r = await pool.query(
    `INSERT INTO groq_daily_usage (day, count) VALUES ($1, 1)
     ON CONFLICT (day) DO UPDATE SET count = groq_daily_usage.count + 1
       WHERE groq_daily_usage.count < $2
     RETURNING count`,
    [day, ceiling],
  );
  return r.rowCount === 1 ? { ok: true } : { ok: false, reason: "ceiling_reached" };
}

export interface GroqCeilingOptions {
  ceiling?: number;
  /** Clock override for tests; defaults to the real server clock (acceptable here — a production safety
   * valve, not a fixture-replayed path, the same exception POST /tick (V7) already established). */
  now?: () => Date;
}

const todayUtc = (now: () => Date): string => now().toISOString().slice(0, 10);

/**
 * Wraps a real `LlmProvider` with the global daily Groq ceiling. Before each real `extract`/`wordReply` call,
 * atomically checks-and-increments `groq_daily_usage` for today (UTC). Once the ceiling is already reached,
 * throws the EXISTING `LlmError("rate_limited", ...)` WITHOUT calling the underlying provider at all — this
 * reuses the pipeline's already-tested handling of a Groq rate-limit failure (a `low_confidence` refusal with
 * the safe holding reply plus escalation for `extract`; a fallback to the plain template reply for
 * `wordReply`, via `makeReplyWorder`) instead of inventing a parallel error path. Otherwise increments and
 * calls through to the real provider as normal.
 *
 * Both `extract` AND `wordReply` count against the same ceiling: they are two separate real Groq network
 * calls against the same account-wide request quota (see the module doc comment above).
 */
export function withGroqDailyCeiling(provider: LlmProvider, pool: Pool, opts: GroqCeilingOptions = {}): LlmProvider {
  const ceiling = opts.ceiling ?? DEFAULT_GROQ_DAILY_CEILING;
  const now = opts.now ?? (() => new Date());
  const guard = async (): Promise<void> => {
    const day = todayUtc(now);
    const r = await checkAndBumpGroqUsage(pool, day, ceiling);
    if (!r.ok) {
      throw new LlmError("rate_limited", `Global Groq daily ceiling (${ceiling} requests) reached for ${day}; refusing before calling Groq.`);
    }
  };
  return {
    async extract(input: ExtractInput): Promise<ExtractResult> {
      await guard();
      return provider.extract(input);
    },
    async wordReply(input: WordReplyInput): Promise<WordReplyResult> {
      await guard();
      return provider.wordReply(input);
    },
  };
}
