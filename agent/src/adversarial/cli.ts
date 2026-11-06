// `pnpm adversarial`: offline hostile-input suite (see main.ts). Uses a throwaway database, like `pnpm eval`.
import { randomBytes } from "node:crypto";
import { createTestDb } from "../ledger/test-db.js";
import { adversarialMain } from "./main.js";

for (const name of ["PII_ENC_KEY", "PHONE_HASH_KEY"]) {
  if (!process.env[name]) process.env[name] = randomBytes(32).toString("base64");
}

const db = await createTestDb();
let code = 1;
try {
  const r = await adversarialMain(process.argv.slice(2), { pool: db.pool });
  process.stdout.write(r.out);
  code = r.code;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  await db.drop();
}
process.exit(code);
