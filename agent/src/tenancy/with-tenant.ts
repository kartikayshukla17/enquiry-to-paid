import type { Pool, PoolClient } from "pg";

/** Role every tenant-scoped query runs as. Created by migration 0004; not superuser, not BYPASSRLS. */
export const APP_ROLE = "e2p_app";

/**
 * Runs `fn` in one transaction as the unprivileged app role with the tenant id set for RLS.
 * `SET LOCAL` scopes both the role and `app.tenant_id` to this transaction, so a pooled
 * connection never carries a tenant (or privileges) into its next use. Direct pooled
 * connection only: a transaction-mode pooler would break the session-level assumptions.
 */
export async function withTenant<T>(pool: Pool, tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (typeof tenantId !== "string" || tenantId === "") throw new Error("withTenant needs a non-empty tenant id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
