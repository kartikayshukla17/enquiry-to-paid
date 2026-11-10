/**
 * Public playground support: visitor feedback and a per-visitor daily message cap. Not tenant data (no RLS, no
 * customer PII) — visitor IPs are never stored raw, only an HMAC keyed with a server-only secret.
 */
import { createHmac } from "node:crypto";
import type { Pool } from "pg";

export const DAILY_MESSAGE_CAP = 30;

export function hashVisitorIp(ip: string, key: string): string {
  return createHmac("sha256", key).update(ip).digest("hex");
}

export interface FeedbackInput {
  card: string;
  rating: "up" | "down";
  comment?: string;
  now: string;
}

export async function recordFeedback(pool: Pool, input: FeedbackInput): Promise<void> {
  if (input.rating !== "up" && input.rating !== "down") throw new Error("rating must be 'up' or 'down'");
  if (input.comment !== undefined && input.comment.length > 1000) throw new Error("comment must be at most 1000 characters");
  await pool.query(
    "INSERT INTO playground_feedback (created_at, card, rating, comment) VALUES ($1,$2,$3,$4)",
    [new Date(input.now).toISOString(), input.card, input.rating, input.comment ?? null],
  );
}

export type UsageResult = { ok: true } | { ok: false; reason: "daily_cap" };

/** Atomic check-and-increment: an upsert that only increments while under the cap, so concurrent requests at the
 * boundary can never push the stored count past DAILY_MESSAGE_CAP. */
export async function checkAndBumpUsage(pool: Pool, ipHash: string, day: string): Promise<UsageResult> {
  const r = await pool.query<{ count: number }>(
    `INSERT INTO playground_usage (ip_hash, day, count) VALUES ($1,$2,1)
     ON CONFLICT (ip_hash, day) DO UPDATE SET count = playground_usage.count + 1
       WHERE playground_usage.count < $3
     RETURNING count`,
    [ipHash, day, DAILY_MESSAGE_CAP],
  );
  return r.rowCount === 1 ? { ok: true } : { ok: false, reason: "daily_cap" };
}
