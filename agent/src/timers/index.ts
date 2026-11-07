import type { Tx } from "../availability/types.js";

export type TimerKind = "hold_expiry" | "owner_idle_resume" | "chaser";

/**
 * Schedules a durable timer: a row in Postgres, written in the caller's transaction, so a hold and its
 * expiry timer commit (or vanish) together. Idempotent per (tenant, kind, subject).
 */
export async function scheduleTimer(tx: Tx, t: { tenantId: string; kind: TimerKind; subjectId: string; runAt: string }): Promise<void> {
  await tx.query(
    `INSERT INTO timers (tenant_id, kind, subject_id, run_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, kind, subject_id) DO UPDATE SET run_at = EXCLUDED.run_at, status = 'pending'`,
    [t.tenantId, t.kind, t.subjectId, t.runAt],
  );
}
