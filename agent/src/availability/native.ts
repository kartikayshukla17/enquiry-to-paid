import { scheduleTimer } from "../timers/index.js";
import type { AvailabilityProvider, BlockedQuery, Hold, HoldRequest, HoldResult, Tx } from "./types.js";

/** The tenant's resource when the card does not name one (a venue with one hall). Created on first use. */
export async function defaultResource(tx: Tx, tenantId: string): Promise<string> {
  const id = `${tenantId}:resource:default`;
  await tx.query(
    `INSERT INTO resources (id, tenant_id, location_id, name) VALUES ($1,$2,'main','Main resource') ON CONFLICT (id) DO NOTHING`,
    [id, tenantId],
  );
  return id;
}

const HOLD_COLUMNS = `id, tenant_id, resource_id, thread_id, start_date::text AS start_date, end_date::text AS end_date, expires_at, status`;
interface HoldRow {
  id: string; tenant_id: string; resource_id: string; thread_id: string; start_date: string; end_date: string; expires_at: Date; status: Hold["status"];
}
const toHold = (r: HoldRow): Hold => ({
  id: r.id, tenantId: r.tenant_id, resourceId: r.resource_id, threadId: r.thread_id,
  start: r.start_date, end: r.end_date, expiresAt: r.expires_at.toISOString(), status: r.status,
});

export interface BlockInput {
  tenantId: string;
  resourceId: string;
  start: string;
  end: string;
  reason: string;
  createdBy: string | null;
  source?: "owner_chat" | "calendar" | "system";
}

export interface Block {
  id: string;
  resourceId: string;
  start: string;
  end: string;
  reason: string;
}

/**
 * Serialises writers of one resource (holds and blocks) for the rest of the transaction. This is what keeps
 * concurrent writers from deadlocking on the exclusion constraint; the constraint itself stays as the backstop
 * that makes an overlap impossible even if a writer skips this lock.
 */
async function lockResource(tx: Tx, tenantId: string, resourceId: string): Promise<void> {
  await tx.query("SELECT 1 FROM resources WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, resourceId]);
}

export async function addBlock(tx: Tx, b: BlockInput): Promise<void> {
  await lockResource(tx, b.tenantId, b.resourceId);
  await tx.query(
    `INSERT INTO availability_blocks (tenant_id, resource_id, start_date, end_date, reason, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [b.tenantId, b.resourceId, b.start, b.end, b.reason, b.source ?? "owner_chat", b.createdBy],
  );
}

export async function listBlocks(tx: Tx, tenantId: string, resourceId: string, fromDate: string): Promise<Block[]> {
  const { rows } = await tx.query<{ id: string; resource_id: string; start_date: string; end_date: string; reason: string }>(
    `SELECT id, resource_id, start_date::text, end_date::text, reason FROM availability_blocks
     WHERE tenant_id=$1 AND resource_id=$2 AND end_date >= $3::date ORDER BY start_date, end_date`,
    [tenantId, resourceId, fromDate],
  );
  return rows.map((r) => ({ id: r.id, resourceId: r.resource_id, start: r.start_date, end: r.end_date, reason: r.reason }));
}

/** Removes `date` from every block covering it; a range block is split around the date. Returns how many blocks were touched. */
export async function removeBlockedDate(tx: Tx, tenantId: string, resourceId: string, date: string): Promise<number> {
  const { rows } = await tx.query<{ id: string; start_date: string; end_date: string; reason: string; source: string; created_by: string | null }>(
    `DELETE FROM availability_blocks WHERE tenant_id=$1 AND resource_id=$2 AND start_date <= $3::date AND end_date >= $3::date
     RETURNING id, start_date::text, end_date::text, reason, source, created_by`,
    [tenantId, resourceId, date],
  );
  for (const r of rows) {
    const keep = (s: string, e: string) =>
      tx.query(
        `INSERT INTO availability_blocks (tenant_id, resource_id, start_date, end_date, reason, source, created_by)
         VALUES ($1,$2,$3::date,$4::date,$5,$6,$7)`,
        [tenantId, resourceId, s, e, r.reason, r.source, r.created_by],
      );
    const day = (offset: number) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    if (r.start_date < date) await keep(r.start_date, day(-1));
    if (r.end_date > date) await keep(day(1), r.end_date);
  }
  return rows.length;
}

export const nativeAvailability: AvailabilityProvider = {
  async blockedDates(tx: Tx, q: BlockedQuery): Promise<string[]> {
    const { rows } = await tx.query<{ d: string }>(
      `SELECT d::date::text AS d FROM generate_series($3::date, $4::date, interval '1 day') AS d
       WHERE EXISTS (SELECT 1 FROM availability_blocks b
                     WHERE b.tenant_id=$1 AND b.resource_id=$2 AND d::date BETWEEN b.start_date AND b.end_date)
          OR EXISTS (SELECT 1 FROM holds h
                     WHERE h.tenant_id=$1 AND h.resource_id=$2 AND h.status='active' AND h.expires_at > $5::timestamptz
                       AND ($6::text IS NULL OR h.thread_id <> $6)
                       AND d::date BETWEEN h.start_date AND h.end_date)
       ORDER BY d`,
      [q.tenantId, q.resourceId, q.from, q.to, q.now, q.ignoreThreadId ?? null],
    );
    return rows.map((r) => r.d);
  },

  async placeHold(tx: Tx, req: HoldRequest): Promise<HoldResult> {
    await lockResource(tx, req.tenantId, req.resourceId);
    // The thread's own earlier hold: identical dates and still live -> reuse; otherwise release it (one hold per thread).
    const own = (
      await tx.query<HoldRow>(
        `SELECT ${HOLD_COLUMNS} FROM holds WHERE tenant_id=$1 AND thread_id=$2 AND status='active' FOR UPDATE`,
        [req.tenantId, req.threadId],
      )
    ).rows.map(toHold);
    const same = own.find((h) => h.resourceId === req.resourceId && h.start === req.start && h.end === req.end && Date.parse(h.expiresAt) > Date.parse(req.now));
    if (same) return { ok: true, hold: same, reused: true, sweptExpired: [] };
    await tx.query(`UPDATE holds SET status='released' WHERE tenant_id=$1 AND thread_id=$2 AND status='active'`, [req.tenantId, req.threadId]);

    // Holds that ran out on the injected clock but were not yet swept stop occupying the date now.
    const swept = (
      await tx.query<HoldRow>(
        `UPDATE holds SET status='expired'
         WHERE tenant_id=$1 AND resource_id=$2 AND status='active' AND expires_at <= $3::timestamptz
           AND daterange(start_date, end_date, '[]') && daterange($4::date, $5::date, '[]')
         RETURNING ${HOLD_COLUMNS}`,
        [req.tenantId, req.resourceId, req.now, req.start, req.end],
      )
    ).rows.map(toHold);

    const blocked = await tx.query(
      `SELECT 1 FROM availability_blocks WHERE tenant_id=$1 AND resource_id=$2
         AND daterange(start_date, end_date, '[]') && daterange($3::date, $4::date, '[]') LIMIT 1`,
      [req.tenantId, req.resourceId, req.start, req.end],
    );
    if (blocked.rowCount) return { ok: false, reason: "taken" };

    await tx.query("SAVEPOINT place_hold");
    try {
      const { rows } = await tx.query<HoldRow>(
        `INSERT INTO holds (tenant_id, resource_id, thread_id, start_date, end_date, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${HOLD_COLUMNS}`,
        [req.tenantId, req.resourceId, req.threadId, req.start, req.end, req.expiresAt],
      );
      const hold = toHold(rows[0] as HoldRow);
      await tx.query("RELEASE SAVEPOINT place_hold");
      await scheduleTimer(tx, { tenantId: req.tenantId, kind: "hold_expiry", subjectId: hold.id, runAt: req.expiresAt });
      return { ok: true, hold, reused: false, sweptExpired: swept };
    } catch (e) {
      if ((e as { code?: string }).code === "23P01") {
        await tx.query("ROLLBACK TO SAVEPOINT place_hold");
        return { ok: false, reason: "taken" };
      }
      throw e;
    }
  },
};
