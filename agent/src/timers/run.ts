import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { GENESIS_HASH, appendEntry } from "../ledger/index.js";
import { idleResumeInTxn } from "../owner/takeover.js";
import { runChaserInTxn } from "../chasers/run.js";
import type { ChaserOutbox } from "../chasers/types.js";
import { APP_ROLE } from "../tenancy/with-tenant.js";
import { claimThread, releaseThread } from "./thread-queue.js";

export interface RunResult {
  /** Timers claimed and completed by this call. */
  processed: number;
  expiredHolds: string[];
  /** Threads the owner-idle timer handed back to the agent (T18). */
  resumedThreads: string[];
  /** Chasers (T19) this call really sent, in order. */
  chasersSent: { threadId: string; n: 1 | 2 }[];
}

interface DueTimer {
  id: string;
  tenant_id: string;
  kind: string;
  subject_id: string;
}

/**
 * Runs every timer whose run_at is at or before `now` (the injected clock; nothing here reads the system clock).
 *
 * `pool` must connect as the owner role, the one deliberate cross-tenant path (like `ledger verify`): the claim
 * query has to see every tenant's due timers. Each timer then runs in its own transaction, with the role dropped
 * to the app role and `app.tenant_id` set, so the work itself is under RLS. Claim and work commit together:
 * a crash rolls the claim back and the timer is simply due again; `FOR UPDATE SKIP LOCKED` keeps two workers
 * off the same row. Marking a hold expired is idempotent (only an `active` hold changes), so a replay is a no-op.
 *
 * `timers`' own `FOR UPDATE SKIP LOCKED` only ever stops two workers grabbing the SAME timer row — it does
 * nothing for two DIFFERENT timer rows that belong to the SAME thread (e.g. a due `hold_expiry` and a due
 * `chaser`), which two truly concurrent calls could otherwise claim and process at the same moment (V9). So
 * right after a due timer is claimed, its thread is resolved and durably claimed in `thread_work_queue`
 * (`claimThread`, on the trusted `pool`, not `client` — this table is RLS-exempt and claim/release are their
 * own atomic statements, independent of this per-timer transaction) before any kind-specific branch runs. A
 * lost claim race rolls this iteration back untouched and moves on; the timer stays due for whoever holds the
 * thread to finish. `runId` is one random id per call to `runDueTimers`, reused for every claim that call makes.
 */
export async function runDueTimers(pool: Pool, now: string, opts: { kernel?: KernelBridge; chaserOutbox?: ChaserOutbox } = {}): Promise<RunResult> {
  const kernel = opts.kernel ?? (await loadKernel());
  const result: RunResult = { processed: 0, expiredHolds: [], resumedThreads: [], chasersSent: [] };
  const runId = randomUUID();
  for (;;) {
    const client = await pool.connect();
    let claimedThreadId: string | undefined;
    try {
      await client.query("BEGIN");
      const due = (
        await client.query<DueTimer>(
          `SELECT id, tenant_id, kind, subject_id FROM timers
           WHERE status = 'pending' AND run_at <= $1::timestamptz AND ($2::boolean OR kind <> 'chaser')
           ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [now, opts.chaserOutbox !== undefined],
        )
      ).rows[0];
      if (!due) {
        await client.query("ROLLBACK");
        return result;
      }

      // V9: resolve the due timer's thread (still owner role: a hold_expiry's subject_id is a HOLD id, not a
      // thread id) and claim it before doing any kind-specific work. A hold that's already gone (shouldn't
      // happen) resolves to no thread id; there is then nothing to claim, and the existing "not found"
      // handling below runs exactly as it does today.
      const threadId = due.kind === "hold_expiry" ? (await client.query<{ thread_id: string }>("SELECT thread_id FROM holds WHERE id=$1", [due.subject_id])).rows[0]?.thread_id : due.subject_id;
      if (threadId) {
        const claim = await claimThread(pool, threadId, runId, now);
        if (!claim.ok) {
          // Someone else is already working this thread. Don't process this timer this iteration: roll back
          // (nothing was written), and let the outer loop try the next due timer -- this one is simply due
          // again, same as any other retried timer.
          await client.query("ROLLBACK");
          continue;
        }
        claimedThreadId = threadId;
      }

      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [due.tenant_id]);
      let expired: string | undefined;
      let retryAt: string | undefined;
      if (due.kind === "owner_idle_resume") {
        // The pipeline and the owner handlers lock thread -> ledger head, so this kind locks the thread first too (the timer row
        // is already ours); the up-front head lock below would invert that order and deadlock against a customer message.
        const r = await idleResumeInTxn(client, kernel, { tenantId: due.tenant_id, threadId: due.subject_id, now });
        if (r.resumed) result.resumedThreads.push(due.subject_id);
        else retryAt = r.retryAt;
      } else if (due.kind === "chaser" && opts.chaserOutbox) {
        // Thread first, then the ledger head (the timer row is already ours): the order the pipeline and the stop handler use.
        const r = await runChaserInTxn(client, kernel, opts.chaserOutbox, { tenantId: due.tenant_id, threadId: due.subject_id, now });
        if (r.sent) result.chasersSent.push({ threadId: due.subject_id, n: r.sent });
        retryAt = r.retryAt;
      } else {
        // Thread first, then the ledger head -- the same order every other branch above uses, and the order
        // the live pipeline uses too. This branch's own lock on `holds` never conflicted with that; what did
        // was an unaccounted-for one: `runTimer`'s ledger write (via appendEntry) inserts into ledger_entries,
        // whose FK to `threads` takes an implicit FOR KEY SHARE lock on that thread's row -- AFTER this branch
        // already held ledger_heads FOR UPDATE, backwards from every thread-first branch's order. Two
        // real/concurrent hold_expiry + owner_idle_resume (or chaser) timers for the same tenant, hitting at
        // once, could take these two locks in opposite order and deadlock (reproduced while building V9,
        // whose own claim/release round trips widen the window enough to make it a real, if still rare,
        // failure, not just a theoretical one). Locking the thread explicitly, up front, fixes the order.
        if (threadId) await client.query("SELECT 1 FROM threads WHERE id=$1 FOR UPDATE", [threadId]);
        await client.query(
          "INSERT INTO ledger_heads (tenant_id, last_tenant_seq, last_hash) VALUES ($1, 0, $2) ON CONFLICT (tenant_id) DO NOTHING",
          [due.tenant_id, GENESIS_HASH],
        );
        await client.query("SELECT 1 FROM ledger_heads WHERE tenant_id=$1 FOR UPDATE", [due.tenant_id]);
        expired = await runTimer(client, kernel, due, now);
      }
      if (retryAt) await client.query(`UPDATE timers SET run_at=$2::timestamptz, attempts = attempts + 1 WHERE id=$1`, [due.id, retryAt]);
      else await client.query(`UPDATE timers SET status='done', done_at=$2::timestamptz, attempts = attempts + 1 WHERE id=$1`, [due.id, now]);
      await client.query("COMMIT");
      result.processed += 1;
      if (expired) result.expiredHolds.push(expired);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
      // Always release a claim this call actually took -- a thrown error above must not leave it stuck.
      if (claimedThreadId) await releaseThread(pool, claimedThreadId, runId);
    }
  }
}

/** Returns the hold id when this run is the one that expired it. */
async function runTimer(client: PoolClient, kernel: KernelBridge, t: DueTimer, now: string): Promise<string | undefined> {
  if (t.kind !== "hold_expiry") throw new Error(`unknown timer kind: ${t.kind}`);
  const { rows } = await client.query<{ id: string; thread_id: string; resource_id: string; start_date: string; end_date: string; expires_at: Date }>(
    `UPDATE holds SET status='expired' WHERE id=$1 AND status='active'
     RETURNING id, thread_id, resource_id, start_date::text, end_date::text, expires_at`,
    [t.subject_id],
  );
  const h = rows[0];
  if (!h) return undefined;
  await appendEntry(client, kernel, {
    tenantId: t.tenant_id,
    threadId: h.thread_id,
    at: now,
    type: "hold",
    payload: { action: "expired", holdId: h.id, resourceId: h.resource_id, start: h.start_date, end: h.end_date, expiresAt: h.expires_at.toISOString() },
  });
  return h.id;
}
