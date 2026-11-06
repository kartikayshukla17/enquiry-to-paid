// `pnpm provider enable|check <provider> <model>`: the gate behind enabling a provider or model (see gate.ts).
// Uses a throwaway database (created and dropped here), like `pnpm eval`.
import { randomBytes } from "node:crypto";
import { createTestDb } from "../ledger/test-db.js";
import { providerMain } from "./cli-main.js";

for (const name of ["PII_ENC_KEY", "PHONE_HASH_KEY"]) {
  if (!process.env[name]) process.env[name] = randomBytes(32).toString("base64");
}

const db = await createTestDb();
let code = 2;
try {
  const r = await providerMain(process.argv.slice(2), { pool: db.pool });
  process.stdout.write(r.out);
  code = r.code;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  await db.drop();
}
process.exit(code);
