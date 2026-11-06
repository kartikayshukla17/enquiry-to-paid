// `pnpm card compile|approve|demo`: see cli-main.ts. compile needs no database; approve uses DATABASE_URL like `pnpm sim`.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createTestDb, DEFAULT_DATABASE_URL } from "../ledger/test-db.js";
import { migrate } from "../ledger/migrate.js";
import { cardMain } from "./cli-main.js";
import { runDemo } from "./demo.js";

for (const name of ["PII_ENC_KEY", "PHONE_HASH_KEY"]) {
  if (!process.env[name]) process.env[name] = randomBytes(32).toString("base64");
}

const args = process.argv.slice(2).filter((a) => a !== "--");
let code = 2;
try {
  if (args[0] === "demo") {
    const db = await createTestDb();
    try {
      process.stdout.write(await runDemo(db.pool));
      code = 0;
    } finally {
      await db.drop();
    }
  } else if (args[0] === "approve") {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 2 });
    try {
      await migrate(pool);
      const r = await cardMain(args, { pool });
      process.stdout.write(r.out);
      code = r.code;
    } finally {
      await pool.end();
    }
  } else {
    const r = await cardMain(args);
    process.stdout.write(r.out);
    code = r.code;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
}
process.exit(code);
