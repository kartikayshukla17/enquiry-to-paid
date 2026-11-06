import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { withTenant } from "./with-tenant.js";

let db: TestDb;
const A = "tenant-a";
const B = "tenant-b";

/** Tables that are deliberately NOT tenant-scoped. Every entry needs a reason. */
const EXEMPT: Record<string, string> = {
  schema_migrations: "migration bookkeeping, no tenant data; the app role has no grant on it",
};
/** Better Auth's own tables (added in a later migration); see the Ruling in agent/README.md. */
const AUTH_TABLES = ["user", "session", "account", "verification", "organization", "member", "invitation"];

beforeAll(async () => {
  db = await createTestDb();
  const p = db.pool; // superuser: seeds both tenants, bypasses RLS
  for (const t of [A, B]) {
    await p.query("INSERT INTO tenants (id, name) VALUES ($1,$1)", [t]);
    await p.query("INSERT INTO customers (id, tenant_id, phone_hash) VALUES ($1,$2,$3)", [`${t}-c`, t, `h-${t}`]);
    await p.query("INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3)", [`${t}-th`, t, `${t}-c`]);
    await p.query("INSERT INTO rate_cards (id, tenant_id, card_id, version, content_hash, compiled) VALUES ($1,$2,'c',1,'h','{}')", [`${t}-rc`, t]);
    await p.query(
      `INSERT INTO ledger_entries (tenant_id, tenant_seq, thread_id, at, type, payload, prev_hash, hash)
       VALUES ($1,1,$2,now(),'enquiry','{}','0','x')`,
      [t, `${t}-th`],
    );
    await p.query("INSERT INTO ledger_heads (tenant_id, last_tenant_seq, last_hash) VALUES ($1,1,'x')", [t]);
    await p.query("INSERT INTO members (id, tenant_id, role) VALUES ($1,$2,'owner')", [`${t}-m`, t]);
    await p.query("INSERT INTO resources (id, tenant_id, location_id, name) VALUES ($1,$2,'loc','Hall')", [`${t}-r`, t]);
  }
});
afterAll(async () => {
  await db.drop();
});

const SCOPED = ["tenants", "customers", "threads", "rate_cards", "ledger_entries", "ledger_heads", "members", "resources"];

describe("row-level security", () => {
  it("app role is neither superuser nor BYPASSRLS", async () => {
    const { rows } = await db.pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='e2p_app'");
    expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  it("every table in public has RLS enabled and forced, except documented exemptions", async () => {
    const { rows } = await db.pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`,
    );
    const skip = new Set([...Object.keys(EXEMPT), ...AUTH_TABLES]);
    const unprotected = rows.filter((r) => !skip.has(r.relname) && !(r.relrowsecurity && r.relforcerowsecurity)).map((r) => r.relname);
    expect(unprotected).toEqual([]);
    for (const t of SCOPED) expect(rows.map((r) => r.relname)).toContain(t);
  });

  it.each(["threads", "rate_cards", "customers", "ledger_entries", "members", "resources", "ledger_heads", "tenants"])(
    "tenant A cannot see tenant B rows in %s",
    async (table) => {
      const own = await withTenant(db.pool, A, (c) => c.query(`SELECT tenant_id FROM ${table}`));
      expect(own.rows.map((r) => r.tenant_id)).toEqual([A]);
      const other = await withTenant(db.pool, A, (c) => c.query(`SELECT * FROM ${table} WHERE tenant_id = $1`, [B]));
      expect(other.rowCount).toBe(0);
    },
  );

  it("fails closed when no tenant is set", async () => {
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE e2p_app");
      for (const t of SCOPED) expect((await c.query(`SELECT 1 FROM ${t}`)).rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("the tenant and role do not leak to the next use of a pooled connection", async () => {
    await withTenant(db.pool, A, (c) => c.query("SELECT 1"));
    const c = await db.pool.connect();
    try {
      expect((await c.query("SELECT current_setting('app.tenant_id', true) AS t")).rows[0].t).toBeFalsy();
      expect((await c.query("SELECT current_user AS u")).rows[0].u).not.toBe("e2p_app");
    } finally {
      c.release();
    }
  });

  it("INSERT with another tenant's tenant_id fails the WITH CHECK", async () => {
    await expect(
      withTenant(db.pool, A, (c) => c.query("INSERT INTO threads (id, tenant_id, customer_id) VALUES ('x',$1,$2)", [B, `${A}-c`])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(db.pool, A, (c) =>
        c.query(
          `INSERT INTO ledger_entries (tenant_id, tenant_seq, thread_id, at, type, payload, prev_hash, hash)
           VALUES ($1,9,$2,now(),'enquiry','{}','0','x')`,
          [B, `${A}-th`],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another tenant's rows (zero rows touched)", async () => {
    const upd = await withTenant(db.pool, A, (c) => c.query("UPDATE threads SET state='closed' WHERE tenant_id=$1", [B]));
    expect(upd.rowCount).toBe(0);
    const del = await withTenant(db.pool, A, (c) => c.query("DELETE FROM members WHERE tenant_id=$1", [B]));
    expect(del.rowCount).toBe(0);
    const still = await db.pool.query("SELECT state FROM threads WHERE tenant_id=$1", [B]);
    expect(still.rows[0].state).toBe("open");
  });

  it("the ledger is INSERT/SELECT only for the app role", async () => {
    await expect(withTenant(db.pool, A, (c) => c.query("UPDATE ledger_entries SET payload='{}'"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db.pool, A, (c) => c.query("DELETE FROM ledger_entries"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db.pool, A, (c) => c.query("TRUNCATE ledger_entries"))).rejects.toThrow(/permission denied/);
  });

  it("the app role cannot read migrations, disable RLS or switch role", async () => {
    await expect(withTenant(db.pool, A, (c) => c.query("SELECT * FROM schema_migrations"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db.pool, A, (c) => c.query("ALTER TABLE threads DISABLE ROW LEVEL SECURITY"))).rejects.toThrow();
  });
});

describe("Supabase Data API is unreachable", () => {
  const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

  it.each(["anon", "authenticated"])("%s exists and has no privilege on any table or the schema", async (role) => {
    const { rows: exists } = await db.pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1", [role]);
    expect(exists[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const { rows } = await db.pool.query<{ oid: string; relname: string }>(
      `SELECT c.oid::regclass::text AS oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')`,
    );
    expect(rows.length).toBeGreaterThan(5);
    const granted: string[] = [];
    for (const r of rows) {
      for (const p of PRIVS) {
        const q = await db.pool.query("SELECT has_table_privilege($1,$2,$3) AS ok", [role, r.oid, p]);
        if (q.rows[0].ok) granted.push(`${r.relname}:${p}`);
      }
    }
    expect(granted).toEqual([]);
    expect((await db.pool.query("SELECT has_schema_privilege($1,'public','USAGE') AS ok", [role])).rows[0].ok).toBe(false);
  });

  it("a table created later is not reachable by anon/authenticated either", async () => {
    await db.pool.query("CREATE TABLE later_table (id int)");
    for (const role of ["anon", "authenticated"]) {
      expect((await db.pool.query("SELECT has_table_privilege($1,'later_table','SELECT') AS ok", [role])).rows[0].ok).toBe(false);
    }
    await db.pool.query("DROP TABLE later_table");
  });

  it("the repo ships no Supabase API exposure and documents how to disable the Data API", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const cfg = `${root}supabase/config.toml`;
    if (existsSync(cfg)) {
      expect(readFileSync(cfg, "utf8")).not.toMatch(/\[api\][^[]*enabled\s*=\s*true/);
    }
    const doc = readFileSync(`${root}docs/supabase-lockdown.md`, "utf8");
    expect(doc).toMatch(/Enable Data API/);
  });
});
