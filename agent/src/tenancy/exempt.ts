/**
 * Tables in `public` that are deliberately NOT tenant-scoped (no tenant_id, no RLS). Every entry needs a reason.
 * Tests enumerate all tables and fail for any table that is neither tenant-scoped nor listed here.
 */
export const TENANT_EXEMPT: Record<string, string> = {
  kill_switch_global: "the platform-wide kill switch is one row that applies to every tenant, so it has no tenant_id; e2p_app may only SELECT it (0009_kill_switch.sql)",
  schema_migrations: "migration bookkeeping, no tenant data; the app role has no grant on it",
  user: "Better Auth: looked up by email before a tenant is known; no privileges for e2p_app/anon/authenticated (0005_auth.sql)",
  session: "Better Auth: looked up by token before a tenant is known; no privileges for e2p_app/anon/authenticated",
  account: "Better Auth: credentials, looked up before a tenant is known; no privileges for e2p_app/anon/authenticated",
  verification: "Better Auth: one-time tokens, no tenant; no privileges for e2p_app/anon/authenticated",
  organization: "Better Auth: organization.id IS the tenant id; managed by the auth library only",
  member: "Better Auth: organization membership; mirrored into the RLS-protected `members` table",
  invitation: "Better Auth: pending invitations; managed by the auth library only",
  playground_feedback: "public playground (not tenant data): visitor feedback with no tenant_id; written only by the sim server's own pool connection, never through e2p_app or the tenant pipeline (0016_playground.sql)",
  playground_usage: "public playground (not tenant data): per-visitor-IP-hash daily message cap, no tenant_id; same access as playground_feedback (0016_playground.sql)",
  thread_work_queue: "V9 per-thread claim for /tick: one row per thread (a globally unique id, no tenant data) plus a bookkeeping timestamp/run-id; touched only by the agent's own trusted pool connection (agent/src/timers/thread-queue.ts), never e2p_app/RLS; e2p_app has no grant on it at all (0017_thread_work_queue.sql)",
  groq_daily_usage: "V10 global free-tier ceiling on real Groq network calls: one row per day, shared across every tenant (one Groq API key for the whole playground), so it has no tenant_id; touched only by the agent's own trusted pool connection (agent/src/llm/groq-ceiling.ts), never e2p_app/RLS; e2p_app has no grant on it at all (0018_groq_daily_usage.sql)",
};
