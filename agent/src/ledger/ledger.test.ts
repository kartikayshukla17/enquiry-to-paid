import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { appendCorrection, appendEntry, verifyLedger, type LedgerRow, type NewEntry } from "./index.js";
import { createTestDb, type TestDb } from "./test-db.js";

let db: TestDb;
let kernel: KernelBridge;
const AT = "2026-11-07T10:00:00.000Z";

beforeAll(async () => {
  kernel = await loadKernel();
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

async function seedTenant(pool: Pool, tenant: string): Promise<string> {
  const thread = `${tenant}-th`;
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1,$1) ON CONFLICT DO NOTHING", [tenant]);
  await pool.query(
    "INSERT INTO customers (id, tenant_id, phone_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [`${tenant}-c`, tenant, `h-${tenant}`],
  );
  await pool.query(
    "INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [thread, tenant, `${tenant}-c`],
  );
  return thread;
}

async function append(pool: Pool, e: NewEntry): Promise<LedgerRow> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const row = await appendEntry(c, kernel, e);
    await c.query("COMMIT");
    return row;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

const entry = (tenantId: string, threadId: string, n: number): NewEntry => ({
  tenantId,
  threadId,
  at: AT,
  type: "quote",
  payload: { total: 1000 + n, lines: [{ ruleId: "r1" }] },
});

describe("ledger chain", () => {
  it("verifies a normal run and numbers entries per tenant", async () => {
    const t = "t-normal";
    const th = await seedTenant(db.pool, t);
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(await append(db.pool, entry(t, th, i)));
    expect(rows.map((r) => r.tenantSeq)).toEqual([1, 2, 3, 4]);
    expect(rows[0]?.prevHash).toBe("0".repeat(64));
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(await verifyLedger(db.pool, kernel, { tenantId: t })).toEqual({
      ok: true,
      tenants: [{ tenantId: t, count: 4 }],
    });
  });

  it("keeps each tenant's chain independent", async () => {
    const a = await seedTenant(db.pool, "t-a");
    const b = await seedTenant(db.pool, "t-b");
    await append(db.pool, entry("t-a", a, 1));
    const first = await append(db.pool, entry("t-b", b, 1));
    expect(first.tenantSeq).toBe(1);
    expect(first.prevHash).toBe("0".repeat(64));
  });

  it("stores rate-card hash, model, provider, region and cost on a quote row", async () => {
    const t = "t-prov";
    const th = await seedTenant(db.pool, t);
    const row = await append(db.pool, {
      ...entry(t, th, 1),
      rateCardHash: "abc",
      modelId: "fixture",
      provider: "fixture",
      region: "local",
      costMinor: 0,
    });
    expect(row).toMatchObject({ rateCardHash: "abc", modelId: "fixture", provider: "fixture", region: "local", costMinor: 0 });
    expect((await verifyLedger(db.pool, kernel, { tenantId: t })).ok).toBe(true);
  });

  it("keeps the chain valid under concurrent appends", async () => {
    const t = "t-conc";
    const th = await seedTenant(db.pool, t);
    await Promise.all(Array.from({ length: 24 }, (_, i) => append(db.pool, entry(t, th, i))));
    const { rows } = await db.pool.query("SELECT tenant_seq::int AS s FROM ledger_entries WHERE tenant_id=$1 ORDER BY tenant_seq", [t]);
    expect(rows.map((r: { s: number }) => r.s)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(await verifyLedger(db.pool, kernel, { tenantId: t })).toEqual({
      ok: true,
      tenants: [{ tenantId: t, count: 24 }],
    });
  });

  it("writes corrections as new rows that reference the original", async () => {
    const t = "t-corr";
    const th = await seedTenant(db.pool, t);
    const original = await append(db.pool, entry(t, th, 1));
    const c = await db.pool.connect();
    const fix = await appendCorrection(c, kernel, { seq: original.seq }, { reason: "typo", total: 999 }, AT);
    c.release();
    expect(fix).toMatchObject({ type: "correction", corrects: original.seq, threadId: th, tenantId: t });
    expect(fix.seq).not.toBe(original.seq);
    const { rows } = await db.pool.query("SELECT payload FROM ledger_entries WHERE seq=$1", [original.seq]);
    expect((rows[0] as { payload: { total: number } }).payload.total).toBe(1001);
    expect((await verifyLedger(db.pool, kernel, { tenantId: t })).ok).toBe(true);
  });

  it("rejects a correction for a row that does not exist", async () => {
    const c = await db.pool.connect();
    await expect(appendCorrection(c, kernel, { seq: 999_999 }, {}, AT)).rejects.toThrow(/not found/);
    c.release();
  });
});

describe("append-only at the database", () => {
  it("blocks UPDATE, DELETE and TRUNCATE", async () => {
    const t = "t-block";
    const th = await seedTenant(db.pool, t);
    const row = await append(db.pool, entry(t, th, 1));
    await expect(db.pool.query("UPDATE ledger_entries SET payload='{}' WHERE seq=$1", [row.seq])).rejects.toThrow(/append-only/);
    await expect(db.pool.query("DELETE FROM ledger_entries WHERE seq=$1", [row.seq])).rejects.toThrow(/append-only/);
    await expect(db.pool.query("TRUNCATE ledger_entries")).rejects.toThrow(/append-only/);
  });
});

describe("verifyLedger detects tampering (trigger disabled as superuser)", () => {
  async function tamper(sql: string, params: unknown[] = []) {
    const c = await db.pool.connect();
    try {
      await c.query("ALTER TABLE ledger_entries DISABLE TRIGGER USER");
      await c.query(sql, params);
    } finally {
      await c.query("ALTER TABLE ledger_entries ENABLE TRIGGER USER");
      c.release();
    }
  }

  it("names the exact edited row", async () => {
    const t = "t-edit";
    const th = await seedTenant(db.pool, t);
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await append(db.pool, entry(t, th, i)));
    const victim = rows[2] as LedgerRow;
    await tamper(`UPDATE ledger_entries SET payload = '{"total": 1}' WHERE seq=$1`, [victim.seq]);
    expect(await verifyLedger(db.pool, kernel, { tenantId: t })).toEqual({
      ok: false,
      tenantId: t,
      seq: victim.seq,
      tenantSeq: 3,
      reason: "hash_mismatch",
    });
  });

  it("names the row after a deleted row", async () => {
    const t = "t-del";
    const th = await seedTenant(db.pool, t);
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(await append(db.pool, entry(t, th, i)));
    await tamper("DELETE FROM ledger_entries WHERE seq=$1", [(rows[1] as LedgerRow).seq]);
    expect(await verifyLedger(db.pool, kernel, { tenantId: t })).toMatchObject({
      ok: false,
      tenantId: t,
      tenantSeq: 3,
      reason: "seq_gap",
    });
  });

  it("detects a truncated tail via the head row", async () => {
    const t = "t-tail";
    const th = await seedTenant(db.pool, t);
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(await append(db.pool, entry(t, th, i)));
    await tamper("DELETE FROM ledger_entries WHERE seq=$1", [(rows[2] as LedgerRow).seq]);
    expect(await verifyLedger(db.pool, kernel, { tenantId: t })).toMatchObject({
      ok: false,
      tenantId: t,
      tenantSeq: 3,
      reason: "tail_truncated",
    });
  });

  it("walks every tenant when none is given and reports the broken one", async () => {
    const res = await verifyLedger(db.pool, kernel);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(["t-edit", "t-del", "t-tail"]).toContain(res.tenantId);
  });
});

describe("pnpm ledger verify (CLI)", () => {
  const run = (...args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const connectionString = (db.pool as unknown as { options: { connectionString: string } }).options.connectionString;
      execFile(
        "pnpm",
        ["exec", "tsx", "src/ledger/cli.ts", "verify", ...args],
        { env: { ...process.env, DATABASE_URL: connectionString } },
        (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
      );
    });

  it("prints OK and exits 0 for an intact tenant", async () => {
    const r = await run("--tenant", "t-normal");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/OK/);
  });

  it("prints the exact broken row and exits non-zero", async () => {
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/BROKEN at tenant=t-\w+ seq=\S+ tenant_seq=\d+ reason=(hash_mismatch|seq_gap|tail_truncated)/);
  });
});
