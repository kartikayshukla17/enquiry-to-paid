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
};
