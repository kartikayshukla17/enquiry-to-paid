import type { Pool, PoolClient } from "pg";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { APP_ROLE } from "../tenancy/with-tenant.js";

export interface RunResult {
  /** Timers claimed and completed by this call. */
  processed: number;
  expiredHolds: string[];
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
 */
export async function runDueTimers(pool: Pool, now: string, opts: { kernel?: KernelBridge } = {}): Promise<RunResult> {
  const kernel = opts.kernel ?? (await loadKernel());
  const result: RunResult = { processed: 0, expiredHolds: [] };
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const due = (
        await client.query<DueTimer>(
          `SELECT id, tenant_id, kind, subject_id FROM timers
           WHERE status = 'pending' AND run_at <= $1::timestamptz
           ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [now],
        )
      ).rows[0];
      if (!due) {
        await client.query("ROLLBACK");
        return result;
      }
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [due.tenant_id]);
      const expired = await runTimer(client, kernel, due, now);
      await client.query(`UPDATE timers SET status='done', done_at=$2::timestamptz, attempts = attempts + 1 WHERE id=$1`, [due.id, now]);
      await client.query("COMMIT");
      result.processed += 1;
      if (expired) result.expiredHolds.push(expired);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
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
