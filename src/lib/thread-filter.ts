/**
 * The inbox's `threads.state` filter (V4). Threads are fetched once from GET /api/app/threads and
 * filtered client-side at v1 scale -- no query params on the agent endpoint are needed for this.
 * Pulled out as a pure function so it is directly unit-testable, same precedent as
 * src/lib/app-nav.ts's `activeNavKey`.
 */

/** Mirrors the `threads.state` CHECK constraint in agent/db/migrations/0001_init.sql. */
export const THREAD_STATES = ["open", "quoted", "refused", "paused_owner", "booked", "collected", "closed"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];
export type ThreadStateFilter = "all" | ThreadState;

export function filterThreadsByState<T extends { state: string }>(threads: T[], filter: ThreadStateFilter): T[] {
  return filter === "all" ? threads : threads.filter((t) => t.state === filter);
}
