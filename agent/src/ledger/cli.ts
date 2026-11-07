import pg from "pg";
import { loadKernel } from "../kernel/index.js";
import { proofForThread } from "../payments/proof.js";
import { verifyLedger } from "./index.js";
import { DEFAULT_DATABASE_URL } from "./test-db.js";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "verify" && cmd !== "proof") {
  console.error("usage: pnpm ledger verify [--tenant <id>] | pnpm ledger proof <threadId> [--tenant <id>]");
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
  if (cmd === "proof") {
    // Owner-role connection (like verify): the thread's tenant is looked up first, then the proof reads it under that tenant's RLS.
    const threadId = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--tenant");
    if (!threadId) {
      console.error("usage: pnpm ledger proof <threadId> [--tenant <id>]");
      process.exit(2);
    }
    const t = tenantId ?? (await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM threads WHERE id=$1", [threadId])).rows[0]?.tenant_id;
    if (!t) {
      console.log(`billable: no\nwhy: unknown thread ${threadId}`);
      process.exitCode = 1;
    } else {
      const p = await proofForThread(pool, await loadKernel(), { tenantId: t, threadId });
      console.log(`thread ${p.threadId} (tenant ${p.tenantId})`);
      console.log(`billable: ${p.billable}${p.amountMinor !== undefined ? ` (${p.amountMinor} minor units ${p.currency})` : ""}`);
      console.log(`why: ${p.why}`);
      console.log(`chain verified: ${p.chainVerified ? "yes" : "no"}`);
      for (const e of p.chain) console.log(`  #${String(e.tenantSeq).padStart(3)} ${e.at} ${e.type.padEnd(16)} ${e.hash.slice(0, 12)}  ${e.summary}`);
      process.exitCode = p.billable === "yes" ? 0 : 1;
    }
  } else {
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
  }
} catch (e) {
  console.error(`ledger ${cmd}: error: ${(e as Error).message}`);
  process.exitCode = 2;
} finally {
  await pool.end();
}
