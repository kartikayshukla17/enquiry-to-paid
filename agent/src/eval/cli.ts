// `pnpm eval [--write-baseline] [--check]`: offline eval over the labelled sets (see cli-main.ts).
// Uses a throwaway database (created and dropped here) so it never touches the dev ledger.
import { randomBytes } from "node:crypto";
import { createTestDb } from "../ledger/test-db.js";
import { evalMain } from "./cli-main.js";

// Demo/CI convenience only: nothing readable survives the run.
for (const name of ["PII_ENC_KEY", "PHONE_HASH_KEY"]) {
  if (!process.env[name]) process.env[name] = randomBytes(32).toString("base64");
}

const db = await createTestDb();
let code = 1;
try {
  const r = await evalMain(process.argv.slice(2), { pool: db.pool });
  process.stdout.write(r.out);
  code = r.code;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  await db.drop();
}
process.exit(code);
