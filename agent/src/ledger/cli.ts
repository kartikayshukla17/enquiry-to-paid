import pg from "pg";
import { loadKernel } from "../kernel/index.js";
import { verifyLedger } from "./index.js";
import { DEFAULT_DATABASE_URL } from "./test-db.js";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "verify") {
  console.error("usage: pnpm ledger verify [--tenant <id>]");
  process.exit(2);
}
const ti = rest.indexOf("--tenant");
const tenantId = ti >= 0 ? rest[ti + 1] : undefined;
if (ti >= 0 && !tenantId) {
  console.error("--tenant needs an id");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 1 });
try {
  const res = await verifyLedger(pool, await loadKernel(), tenantId ? { tenantId } : {});
  if (res.ok) {
    const total = res.tenants.reduce((n, t) => n + t.count, 0);
    console.log(`ledger verify: OK (${res.tenants.length} tenant(s), ${total} entries)`);
  } else {
    console.error(
      `ledger verify: BROKEN at tenant=${res.tenantId} seq=${res.seq ?? "-"} tenant_seq=${res.tenantSeq ?? "-"} reason=${res.reason}`,
    );
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`ledger verify: error: ${(e as Error).message}`);
  process.exitCode = 2;
} finally {
  await pool.end();
}
