import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "./migrate.js";

export const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:54329/e2p";

export interface TestDb {
  pool: pg.Pool;
  drop(): Promise<void>;
}

/** Creates a throwaway database (one per test file), migrated; `drop()` removes it. */
export async function createTestDb(): Promise<TestDb> {
  const base = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const name = `e2p_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: base.toString(), max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  await migrate(pool);
  return {
    pool,
    async drop() {
      await pool.end();
      const a = new pg.Pool({ connectionString: base.toString(), max: 1 });
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
