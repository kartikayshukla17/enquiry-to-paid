import type { AvailabilityProvider, Tx } from "../availability/types.js";
import type { Outcome } from "../kernel/types.js";

export const holdHoursOf = (card: unknown): number => {
  const h = (card as { holdHours?: unknown }).holdHours;
  return typeof h === "number" && Number.isFinite(h) && h > 0 ? h : 0;
};

export const timezoneOf = (card: unknown): string => {
  const z = (card as { timezone?: unknown }).timezone;
  return typeof z === "string" && z !== "" ? z : "UTC";
};

/** Optional card field `offerAlternatives`; absent means off. */
export const offersAlternatives = (card: unknown): boolean => (card as { offerAlternatives?: unknown }).offerAlternatives === true;

/** True when this thread's latest quote was valid until an instant at or before `now`: it is re-evaluated, not honoured. */
export async function priorQuoteExpired(tx: Tx, threadId: string, now: string): Promise<boolean> {
  const { rows } = await tx.query<{ valid_until: string | null }>(
    "SELECT payload->>'validUntil' AS valid_until FROM ledger_entries WHERE thread_id = $1 AND type = 'quote' ORDER BY seq DESC LIMIT 1",
    [threadId],
  );
  const until = rows[0]?.valid_until;
  return until != null && Date.parse(until) <= Date.parse(now);
}

const ALTERNATIVE_WINDOW_DAYS = 14;
const MAX_ALTERNATIVES = 3;

/** Nearest dates around `date` that the provider says are free AND the kernel would quote. Never creates a hold. */
export async function alternativeDates(
  tx: Tx,
  provider: AvailabilityProvider,
  evaluate: (blocked: string[], onDate?: string) => Outcome,
  q: { tenantId: string; resourceId: string; threadId: string; date: string; now: string; blocked: string[] },
): Promise<string[]> {
  const day = (offset: number) => new Date(Date.parse(`${q.date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const taken = new Set(
    await provider.blockedDates(tx, {
      tenantId: q.tenantId, resourceId: q.resourceId, from: day(-ALTERNATIVE_WINDOW_DAYS), to: day(ALTERNATIVE_WINDOW_DAYS), now: q.now, ignoreThreadId: q.threadId,
    }),
  );
  const out: string[] = [];
  for (let i = 1; i <= ALTERNATIVE_WINDOW_DAYS && out.length < MAX_ALTERNATIVES; i++) {
    for (const d of [day(i), day(-i)]) {
      if (out.length >= MAX_ALTERNATIVES || taken.has(d)) continue;
      if (evaluate(q.blocked, d).kind === "quote") out.push(d);
    }
  }
  return out;
}
