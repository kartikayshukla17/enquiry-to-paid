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
