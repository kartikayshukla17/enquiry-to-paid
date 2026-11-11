/**
 * V9: a durable, per-thread claim in `thread_work_queue`, closing the gap `timers`' own row-level
 * `FOR UPDATE SKIP LOCKED` can't: two DIFFERENT due timer rows for the SAME thread, claimed by two truly
 * concurrent /tick calls at once. `claimed_at`/`claimed_by` are real columns (not just a transactional lock)
 * so a claim survives past the transaction that took it, through to whatever later commits the release —
 * see run.ts for how a crash between claim and release is handled (try/finally).
 *
 * Both functions take the plain trusted (owner-role) pool directly: this table has no tenant_id and is
 * RLS-exempt by design (tenancy/exempt.ts), touched only by this module, never through withTenant/e2p_app.
 */
import type { Pool } from "pg";

export type ClaimResult = { ok: true } | { ok: false };

/**
 * Claims `threadId` for `runId` if nobody else currently holds it. One atomic upsert (not a separate
 * SELECT ... FOR UPDATE SKIP LOCKED followed by an UPDATE): the row either doesn't exist yet (first claim
 * ever) or exists and is unclaimed (claimed_at IS NULL) for the UPDATE branch to fire. Exactly one
 * concurrent caller for the same threadId gets `{ ok: true }`; everyone else racing it gets `{ ok: false }`.
 */
export async function claimThread(pool: Pool, threadId: string, runId: string, now: string): Promise<ClaimResult> {
  const { rows } = await pool.query(
    `INSERT INTO thread_work_queue (thread_id, claimed_at, claimed_by) VALUES ($1,$2,$3)
     ON CONFLICT (thread_id) DO UPDATE SET claimed_at=$2, claimed_by=$3
       WHERE thread_work_queue.claimed_at IS NULL
     RETURNING thread_id`,
    [threadId, now, runId],
  );
  return rows.length === 1 ? { ok: true } : { ok: false };
}

/**
 * Releases `threadId`'s claim, but only if `runId` is the one that actually holds it: a stale or duplicate
 * release (e.g. from a retried/crashed caller) is a harmless no-op, never an error, and never frees a claim
 * someone else has since taken.
 */
export async function releaseThread(pool: Pool, threadId: string, runId: string): Promise<void> {
  await pool.query(`UPDATE thread_work_queue SET claimed_at=NULL, claimed_by=NULL WHERE thread_id=$1 AND claimed_by=$2`, [threadId, runId]);
}
