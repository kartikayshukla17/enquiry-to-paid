import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { nativeAvailability } from "../availability/native.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { runDueTimers } from "./run.js";

let db: TestDb;
let kernel: KernelBridge;
const T = "tenant-timers";
let n = 0;
const NOW = "2026-11-07T10:00:00Z";

beforeAll(async () => {
  kernel = await loadKernel();
  db = await createTestDb();
  await db.pool.query("INSERT INTO tenants (id, name) VALUES ($1,$1)", [T]);
  await db.pool.query("INSERT INTO customers (id, tenant_id, phone_hash) VALUES ($1,$2,'h')", [`${T}-c`, T]);
  await db.pool.query("INSERT INTO resources (id, tenant_id, location_id, name) VALUES ($1,$2,'l','Hall')", [`${T}-r`, T]);
});
afterAll(async () => {
  await db.drop();
});

async function placeHold(date: string, expiresAt: string): Promise<string> {
  const th = `${T}-th-${++n}`;
  await db.pool.query("INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3)", [th, T, `${T}-c`]);
  const r = await withTenant(db.pool, T, (c) =>
    nativeAvailability.placeHold(c, { tenantId: T, resourceId: `${T}-r`, threadId: th, start: date, end: date, expiresAt, now: NOW }),
  );
  if (!r.ok) throw new Error("hold refused");
  return r.hold.id;
}
const status = async (id: string) => (await db.pool.query("SELECT status FROM holds WHERE id=$1", [id])).rows[0].status as string;

describe("runDueTimers", () => {
  it("does nothing before the hold's expiry and expires it at/after", async () => {
    const id = await placeHold("2026-12-12", "2026-11-09T10:00:00Z");
    expect((await runDueTimers(db.pool, "2026-11-09T09:59:59Z", { kernel })).processed).toBe(0);
    expect(await status(id)).toBe("active");
    const res = await runDueTimers(db.pool, "2026-11-09T10:00:00Z", { kernel });
    expect(res.processed).toBe(1);
    expect(await status(id)).toBe("expired");
  });

  it("is idempotent: a second run changes nothing and writes no second ledger entry", async () => {
    const id = await placeHold("2026-12-19", "2026-11-09T10:00:00Z");
    await runDueTimers(db.pool, "2026-11-10T00:00:00Z", { kernel });
    const count = async () => (await db.pool.query("SELECT count(*)::int AS n FROM ledger_entries WHERE type='hold' AND payload->>'holdId'=$1", [id])).rows[0].n;
    const before = await count();
    expect(before).toBe(1);
    expect((await runDueTimers(db.pool, "2026-11-11T00:00:00Z", { kernel })).processed).toBe(0);
    expect(await count()).toBe(1);
  });

  it("releases the date: a new hold can be placed afterwards", async () => {
    await placeHold("2026-12-26", "2026-11-09T10:00:00Z");
    await runDueTimers(db.pool, "2026-11-10T00:00:00Z", { kernel });
    const th = `${T}-th-${++n}`;
    await db.pool.query("INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3)", [th, T, `${T}-c`]);
    const r = await withTenant(db.pool, T, (c) =>
      nativeAvailability.placeHold(c, { tenantId: T, resourceId: `${T}-r`, threadId: th, start: "2026-12-26", end: "2026-12-26", expiresAt: "2026-11-12T00:00:00Z", now: "2026-11-10T00:00:00Z" }),
    );
    expect(r.ok).toBe(true);
  });

  it("does not expire a hold that was released or confirmed meanwhile", async () => {
    const id = await placeHold("2027-01-02", "2026-11-09T10:00:00Z");
    await db.pool.query("UPDATE holds SET status='confirmed' WHERE id=$1", [id]);
    await runDueTimers(db.pool, "2026-11-10T00:00:00Z", { kernel });
    expect(await status(id)).toBe("confirmed");
  });

  it("is durable across restarts: a brand new pool still finds and runs the timer", async () => {
    const id = await placeHold("2027-01-09", "2026-11-09T10:00:00Z");
    const url = (db.pool as unknown as { options: { connectionString: string } }).options.connectionString;
    const fresh = new pg.Pool({ connectionString: url, max: 2 });
    try {
      const res = await runDueTimers(fresh, "2026-11-10T00:00:00Z", { kernel });
      expect(res.processed).toBe(1);
    } finally {
      await fresh.end();
    }
    expect(await status(id)).toBe("expired");
  });

  it("two workers at once never process the same timer twice", async () => {
    const ids = [] as string[];
    for (const d of ["2027-02-06", "2027-02-13", "2027-02-20", "2027-02-27"]) ids.push(await placeHold(d, "2026-11-09T10:00:00Z"));
    const [a, b] = await Promise.all([
      runDueTimers(db.pool, "2026-11-10T00:00:00Z", { kernel }),
      runDueTimers(db.pool, "2026-11-10T00:00:00Z", { kernel }),
    ]);
    expect(a.processed + b.processed).toBe(4);
    for (const id of ids) {
      const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM ledger_entries WHERE type='hold' AND payload->>'holdId'=$1 AND payload->>'action'='expired'", [id]);
      expect(rows[0].n).toBe(1);
    }
  });
});
