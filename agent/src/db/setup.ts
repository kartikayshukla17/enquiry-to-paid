import pg from "pg";
import { migrate } from "../ledger/migrate.js";
import { DEFAULT_DATABASE_URL } from "../ledger/test-db.js";

/**
 * One-shot database setup for a fresh Postgres (Supabase or local): applies every migration, lets the connecting
 * login `SET ROLE e2p_app` (the pipeline runs each tenant transaction as that role, so RLS applies), then proves
 * isolation works. Safe to re-run. Usage: `pnpm db:setup` (reads DATABASE_URL from agent/.env).
 */
async function main(): Promise<number> {
  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const host = new URL(url).host;
  console.log(`target: ${host}`);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const ran = await migrate(pool);
    console.log(ran.length ? `migrations applied: ${ran.length} (${ran[0]} .. ${ran[ran.length - 1]})` : "migrations: already up to date");

    // On Supabase the postgres login is not a superuser: it must be a member of e2p_app to SET ROLE to it.
    try {
      await pool.query("GRANT e2p_app TO CURRENT_USER");
    } catch (e) {
      console.log(`note: GRANT e2p_app TO CURRENT_USER skipped (${(e as Error).message})`);
    }

    // Prove it: as the app role, RLS must apply and a tenant must see nothing it was not given.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE e2p_app");
      const who = await c.query<{ u: string; bypass: boolean }>(
        "SELECT current_user AS u, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass",
      );
      await c.query("SELECT set_config('app.tenant_id', 'tenant-that-does-not-exist', true)");
      const rows = await c.query<{ n: string }>("SELECT count(*) AS n FROM ledger_entries");
      await c.query("ROLLBACK");
      const { u, bypass } = who.rows[0]!;
      console.log(`as ${u}: bypasses RLS = ${bypass}; rows visible to an unknown tenant = ${rows.rows[0]!.n}`);
      if (bypass || rows.rows[0]!.n !== "0") {
        console.error("FAIL: row-level security is not isolating tenants");
        return 1;
      }
    } finally {
      c.release();
    }
    console.log("OK: schema is in place and the app role is isolated by row-level security");
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
