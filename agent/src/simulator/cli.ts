import pg from "pg";
import { DEFAULT_DATABASE_URL } from "../ledger/test-db.js";
import { migrate } from "../ledger/migrate.js";
import { randomBytes } from "node:crypto";
import { runFixture } from "./run-fixture.js";
import { runChat } from "./chat.js";
import { runTwoTenants } from "./two-tenants.js";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, fixture] = argv;
  if ((cmd !== "run" && cmd !== "two-tenants" && cmd !== "chat") || !fixture) {
    console.error(
      'usage: pnpm sim run <fixture.json> | pnpm sim two-tenants <fixture.json> | pnpm sim chat "<english text>" [--tenant <id>] [--card <rate-cards/x.json>] [--customer <ref>] [--words]\n' +
        "  chat/run use LLM_PROVIDER=groq|fixture|keyword (default fixture), LLM_MODEL (must be in agent/config/enabled-providers.json) and LLM_MODE=record|replay|live (default replay, offline)",
    );
    return 2;
  }
  // Demo convenience only: without configured keys, use process-local throwaway ones (nothing readable survives the run).
  for (const name of ["PII_ENC_KEY", "PHONE_HASH_KEY"]) {
    if (!process.env[name]) {
      process.env[name] = randomBytes(32).toString("base64");
      console.error(`note: ${name} not set; using a throwaway key for this run`);
    }
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
  try {
    await migrate(pool);
    if (cmd === "two-tenants") {
      const rep = await runTwoTenants(fixture, { pool });
      for (const t of rep.tenants) {
        console.log(`--- ${t.tenantId}: WhatsApp reply (fictional) ---`);
        console.log(t.reply);
      }
      console.log("\n--- cross-tenant attempts (as tenant 1, asking for tenant 2) ---");
      for (const c of rep.crossReads) console.log(`read ${c.table.padEnd(15)} -> ${c.rows} rows ${c.allowed ? "LEAK" : "(blocked)"}`);
      console.log(`insert with tenant 2's id -> ${rep.crossInsertRejected ? "rejected by row-level security" : "NOT REJECTED"}`);
      return rep.crossReads.every((c) => !c.allowed) && rep.crossInsertRejected ? 0 : 1;
    }
    if (cmd === "chat") {
      const tenant = flag(argv, "--tenant");
      const card = flag(argv, "--card");
      const customer = flag(argv, "--customer");
      const mode = process.env.LLM_MODE ?? "replay";
      console.error(
        `note: LLM_PROVIDER=${process.env.LLM_PROVIDER ?? "fixture"}${process.env.LLM_MODEL ? ` LLM_MODEL=${process.env.LLM_MODEL}` : ""} LLM_MODE=${mode}${mode === "replay" ? " (offline)" : ""}`,
      );
      const c = await runChat(fixture, {
        pool,
        ...(tenant && { tenantId: tenant }),
        ...(card && { card }),
        ...(customer && { customerRef: customer }),
        ...(argv.includes("--words") && { wordReplies: true }),
      });
      console.log("--- WhatsApp reply (fictional) ---");
      console.log(c.reply);
      console.log("\n--- stored ledger row ---");
      console.log(JSON.stringify(c.ledgerRow, null, 2));
      return 0;
    }
    const r = await runFixture(fixture, { pool });
    r.turns.forEach((t, i) => {
      console.log(`--- WhatsApp reply ${i + 1}/${r.turns.length} (fictional) ---`);
      console.log(t.reply);
    });
    console.log("\n--- stored ledger row (last) ---");
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
