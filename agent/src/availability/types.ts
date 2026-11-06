import type { PoolClient } from "pg";

/** A transaction already scoped to one tenant by `withTenant` (RLS applies). */
export type Tx = PoolClient;

export interface BlockedQuery {
  tenantId: string;
  resourceId: string;
  /** Inclusive ISO dates (YYYY-MM-DD). */
  from: string;
  to: string;
  /** The injected clock: a hold whose expires_at is at or before this is not blocking, whether or not the worker ran. */
  now: string;
  /** This thread's own hold never blocks it. */
  ignoreThreadId?: string;
}

export interface HoldRequest {
  tenantId: string;
  resourceId: string;
  threadId: string;
  start: string;
  end: string;
  expiresAt: string;
  now: string;
}

export interface Hold {
  id: string;
  tenantId: string;
  resourceId: string;
  threadId: string;
  start: string;
  end: string;
  expiresAt: string;
  status: "active" | "expired" | "released" | "confirmed";
}

export type HoldResult =
  | { ok: true; hold: Hold; /** The thread already held exactly these dates: nothing new was written. */ reused: boolean; sweptExpired: Hold[] }
  | { ok: false; reason: "taken" };

/**
 * Where availability comes from. The native implementation is Postgres (the authority);
 * a Calendar implementation (T21) plugs in behind the same interface.
 */
export interface AvailabilityProvider {
  /** Dates in [from, to] that cannot be quoted: blocked, or held by another thread and not yet expired. */
  blockedDates(tx: Tx, q: BlockedQuery): Promise<string[]>;
  /**
   * Holds the dates for the thread, atomically: if any other active hold or block overlaps, nothing is written
   * and `taken` is returned. A thread keeps at most one active hold (an older one is released).
   */
  placeHold(tx: Tx, req: HoldRequest): Promise<HoldResult>;
}
