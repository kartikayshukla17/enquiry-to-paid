import pg from "pg";
import { DEFAULT_DATABASE_URL } from "../ledger/test-db.js";
import { migrate } from "../ledger/migrate.js";
import { runFixture } from "./run-fixture.js";

async function main(argv: string[]): Promise<number> {
  const [cmd, fixture] = argv;
  if (cmd !== "run" || !fixture) {
    console.error("usage: pnpm sim run <fixture.json>");
    return 2;
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
  try {
    await migrate(pool);
    const r = await runFixture(fixture, { pool });
    console.log("--- WhatsApp reply (fictional) ---");
    console.log(r.reply);
    console.log("\n--- stored ledger row ---");
    console.log(JSON.stringify(r.ledgerRow, null, 2));
    return 0;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
