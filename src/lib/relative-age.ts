/**
 * "2h ago" style relative-age formatting for the escalation queue (V6). The agent's
 * GET /api/app/escalations only ever sends `at` (an ISO timestamp, the refusal's ledger row) --
 * "how long ago" is a display concern, computed here from `Date.now()` rather than a second
 * "ageSeconds as of request time" field invented on the wire. Pulled out as a pure function so it is
 * directly unit-testable, same precedent as src/lib/thread-filter.ts.
 */
export function formatRelativeAge(at: string, now: number = Date.now()): string {
  const then = new Date(at).getTime();
  if (Number.isNaN(then)) return at;
  const diffMs = Math.max(0, now - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
