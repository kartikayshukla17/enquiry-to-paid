import pg from "pg";
import { readFile } from "node:fs/promises";
import { createTestDb, DEFAULT_DATABASE_URL } from "../ledger/test-db.js";
import { runDueTimers } from "../timers/run.js";
import { migrate } from "../ledger/migrate.js";
import { randomBytes } from "node:crypto";
import { resolveFixture, runFixture } from "./run-fixture.js";
import { runChat } from "./chat.js";
import { loadKernel } from "../kernel/index.js";
import { KillSwitchError, setKillSwitch } from "../killswitch/index.js";
import { runTwoTenants } from "./two-tenants.js";
import { collectingChaserOutbox, type ChaserMessage } from "../chasers/types.js";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, fixture] = argv;
  if (cmd === "tick") {
    // Runs every durable timer due at --now (hold expiry). The clock is always explicit: nothing here reads the system time.
    const now = flag(argv, "--now");
    if (!now || Number.isNaN(Date.parse(now)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(now)) {
      console.error("usage: pnpm sim tick --now <ISO-8601 UTC instant, e.g. 2026-11-09T11:00:00Z>");
      return 2;
    }
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
    try {
      await migrate(pool);
      const outbox: ChaserMessage[] = [];
      const r = await runDueTimers(pool, now, { chaserOutbox: collectingChaserOutbox(outbox) });
      console.log(`tick at ${now}: ${r.processed} timer(s) run, ${r.expiredHolds.length} hold(s) expired and their dates released, ${r.chasersSent.length} chaser(s) sent`);
      for (const id of r.expiredHolds) console.log(`  expired hold ${id}`);
      // Simulated WhatsApp: nothing leaves this machine. A chaser outside the customer's 24h window is shown as the approved template it would be.
      for (const m of outbox) console.log(`  chaser ${m.n} to ${m.customerId} [${m.kind === "template" ? `template ${m.template}` : "free text"}] (simulated): ${m.text}`);
      return 0;
    } finally {
      await pool.end();
    }
  }
  if (cmd === "kill") {
    // pnpm sim kill on|off --now <iso> --by <name>            global switch, flipped by a platform operator (owner DB connection)
    // pnpm sim kill on|off --tenant <id> --now <iso> --by <member id>   tenant switch, flipped by that tenant's owner member
    const tenant = flag(argv, "--tenant");
    const now = flag(argv, "--now");
    const by = flag(argv, "--by");
    if ((fixture !== "on" && fixture !== "off") || !by || !now || Number.isNaN(Date.parse(now))) {
      console.error("usage: pnpm sim kill on|off --now <ISO-8601 UTC instant> --by <operator name | owner member id with --tenant> [--tenant <id>]");
      return 2;
    }
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
    try {
      await migrate(pool);
      const r = await setKillSwitch(
        { pool, kernel: await loadKernel() },
        { target: tenant ? { kind: "tenant", tenantId: tenant } : { kind: "global" }, on: fixture === "on", actor: tenant ? { memberId: by } : { operator: by }, now },
      );
      console.log(`kill switch ${tenant ? `for ${tenant}` : "(global)"} is now ${fixture}${r.changed ? "" : " (no change)"}; ledger entry written`);
      return 0;
    } catch (e) {
      if (e instanceof KillSwitchError) {
        console.error(`refused: ${e.message}`);
        return 1;
      }
      throw e;
    } finally {
      await pool.end();
    }
  }
  if ((cmd !== "run" && cmd !== "owner" && cmd !== "two-tenants" && cmd !== "chat") || !fixture) {
    console.error(
      'usage: pnpm sim run <fixture.json> | pnpm sim owner <fixture.json> (prints the simulated owner WhatsApp thread) | pnpm sim two-tenants <fixture.json> | pnpm sim tick --now <iso> | pnpm sim chat "<english text>" [--tenant <id>] [--card <rate-cards/x.json>] [--customer <ref>] [--words]\n' +
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
    // A fixture with `holds: true` replays a whole timeline on its own clock, so it runs in a throwaway database
    // (re-running against a database that already holds the date would otherwise change the story).
    const scratch = JSON.parse(await readFile(resolveFixture(fixture), "utf8")) as { holds?: boolean; owners?: unknown[]; chasers?: boolean };
    const scratchDb = scratch.holds || scratch.owners || scratch.chasers ? await createTestDb() : undefined;
    let r;
    try {
      r = await runFixture(fixture, { pool: scratchDb?.pool ?? pool });
    } finally {
      await scratchDb?.drop();
    }
    if (scratchDb) console.error("note: this fixture ran in a throwaway database (dropped afterwards)");
    if (cmd === "owner" && !r.ownerTranscript) {
      console.error("this fixture has no `owners`, so there is no owner thread to show");
      return 2;
    }
    for (const l of r.ownerTranscript ?? []) {
      const head = l.dir === "to_owner" ? `agent -> ${l.kind === "reply" ? "sender" : l.to} (${l.kind})` : l.dir === "from_owner" ? `${l.from} -> agent` : `agent -> customer thread ${l.threadId}`;
      console.log(`--- ${l.at} ${head} (fictional) ---`);
      console.log(l.text);
    }
    if (cmd === "owner") return 0;
    r.turns.forEach((t, i) => {
      console.log(`--- WhatsApp reply ${i + 1}/${r.turns.length} (fictional) ---`);
      console.log(t.reply);
    });
    for (const k of r.ticks ?? []) console.log(`--- tick at ${k.at}: ${k.processed} timer(s) run, ${k.expiredHolds.length} hold(s) expired, ${k.chasersSent ?? 0} chaser(s) sent ---`);
    for (const m of r.chasers ?? []) console.log(`--- chaser ${m.n} at ${m.at} [${m.kind === "template" ? `template ${m.template}` : "free text"}] (simulated, fictional) ---\n${m.text}`);
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
