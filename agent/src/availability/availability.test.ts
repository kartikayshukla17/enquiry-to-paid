import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { nativeAvailability, defaultResource, addBlock } from "./native.js";

let db: TestDb;
const T = "tenant-avail";
const OTHER = "tenant-avail-other";
let n = 0;

beforeAll(async () => {
  db = await createTestDb();
  for (const t of [T, OTHER]) {
    await db.pool.query("INSERT INTO tenants (id, name) VALUES ($1,$1)", [t]);
    await db.pool.query("INSERT INTO customers (id, tenant_id, phone_hash) VALUES ($1,$2,$3)", [`${t}-c`, t, `h-${t}`]);
  }
});
afterAll(async () => {
  await db.drop();
});

/** A fresh thread (and, via the caller, a fresh resource) so tests do not share dates. */
async function thread(tenant = T): Promise<string> {
  const id = `${tenant}-th-${++n}`;
  await db.pool.query("INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3)", [id, tenant, `${tenant}-c`]);
  return id;
}
async function resource(tenant = T): Promise<string> {
  const id = `${tenant}-res-${++n}`;
  await db.pool.query("INSERT INTO resources (id, tenant_id, location_id, name) VALUES ($1,$2,'loc','Hall')", [id, tenant]);
  return id;
}
const NOW = "2026-11-07T10:00:00Z";
const hold = (tenantId: string, resourceId: string, threadId: string, date: string, expiresAt = "2026-11-09T10:00:00Z") => ({
  tenantId, resourceId, threadId, start: date, end: date, expiresAt, now: NOW,
});

describe("native availability", () => {
  it("a free date has no blocked dates; a block makes exactly that date blocked", async () => {
    const r = await resource();
    const q = { tenantId: T, resourceId: r, from: "2026-12-11", to: "2026-12-13", now: NOW };
    expect(await withTenant(db.pool, T, (c) => nativeAvailability.blockedDates(c, q))).toEqual([]);
    await withTenant(db.pool, T, (c) => addBlock(c, { tenantId: T, resourceId: r, start: "2026-12-12", end: "2026-12-12", reason: "maintenance", createdBy: "m1" }));
    expect(await withTenant(db.pool, T, (c) => nativeAvailability.blockedDates(c, q))).toEqual(["2026-12-12"]);
  });

  it("a hold blocks other threads but not its own thread", async () => {
    const r = await resource();
    const a = await thread();
    const b = await thread();
    const res = await withTenant(db.pool, T, (c) => nativeAvailability.placeHold(c, hold(T, r, a, "2026-12-12")));
    expect(res.ok).toBe(true);
    const q = { tenantId: T, resourceId: r, from: "2026-12-12", to: "2026-12-12", now: NOW };
    expect(await withTenant(db.pool, T, (c) => nativeAvailability.blockedDates(c, { ...q, ignoreThreadId: b }))).toEqual(["2026-12-12"]);
    expect(await withTenant(db.pool, T, (c) => nativeAvailability.blockedDates(c, { ...q, ignoreThreadId: a }))).toEqual([]);
  });

  it("a second hold on a held date is refused as taken and writes nothing", async () => {
    const r = await resource();
    const a = await thread();
    const b = await thread();
    await withTenant(db.pool, T, (c) => nativeAvailability.placeHold(c, hold(T, r, a, "2026-12-19")));
    const second = await withTenant(db.pool, T, (c) => nativeAvailability.placeHold(c, hold(T, r, b, "2026-12-19")));
    expect(second).toEqual({ ok: false, reason: "taken" });
    const { rows } = await db.pool.query("SELECT thread_id FROM holds WHERE resource_id=$1 AND status='active'", [r]);
    expect(rows).toEqual([{ thread_id: a }]);
  });

  it("a blocked date cannot be held", async () => {
    const r = await resource();
    const a = await thread();
    await withTenant(db.pool, T, (c) => addBlock(c, { tenantId: T, resourceId: r, start: "2026-12-26", end: "2026-12-27", reason: "", createdBy: null }));
    expect(await withTenant(db.pool, T, (c) => nativeAvailability.placeHold(c, hold(T, r, a, "2026-12-27")))).toEqual({ ok: false, reason: "taken" });
  });

  it("the same thread asking again reuses its hold; asking for another date moves it", async () => {
    const r = await resource();
    const a = await thread();
    const first = await withTenant(db.pool, T, (c) => nativeAvailability.placeHold(c, hold(T, r, a, "2027-01-02")));
    const again = await withTenant(db.pool, T, (c) => nativeAvailability.placeHold(c, hold(T, r, a, "2027-01-02")));
    expect(first.ok && again.ok && again.reused && again.hold.id === first.hold.id).toBe(true);
    const moved = await withTenant(db.pool, T, (c) => nativeAvailability.placeHold(c, hold(T, r, a, "2027-01-09")));
    expect(moved.ok && !moved.reused).toBe(true);
    const { rows } = await db.pool.query("SELECT start_date::text AS d, status FROM holds WHERE thread_id=$1 ORDER BY created_at", [a]);
    expect(rows).toEqual([{ d: "2027-01-02", status: "released" }, { d: "2027-01-09", status: "active" }]);
  });

  it("a hold past its expiry does not block even before any worker ran, and can be replaced", async () => {
    const r = await resource();
    const a = await thread();
    const b = await thread();
    await withTenant(db.pool, T, (c) => nativeAvailability.placeHold(c, hold(T, r, a, "2027-01-16", "2026-11-09T10:00:00Z")));
    const later = "2026-11-09T10:00:01Z";
    const q = { tenantId: T, resourceId: r, from: "2027-01-16", to: "2027-01-16", now: later };
    expect(await withTenant(db.pool, T, (c) => nativeAvailability.blockedDates(c, q))).toEqual([]);
    const res = await withTenant(db.pool, T, (c) =>
      nativeAvailability.placeHold(c, { ...hold(T, r, b, "2027-01-16", "2026-11-11T10:00:01Z"), now: later }),
    );
    expect(res.ok && res.sweptExpired.map((h) => h.threadId)).toEqual([a]);
    const { rows } = await db.pool.query("SELECT status FROM holds WHERE thread_id=$1", [a]);
    expect(rows).toEqual([{ status: "expired" }]);
  });

  it("the database itself rejects two overlapping active holds (guard does not depend on application code)", async () => {
    const r = await resource();
    const a = await thread();
    const b = await thread();
    const ins = (th: string) =>
      db.pool.query(
        `INSERT INTO holds (tenant_id, resource_id, thread_id, start_date, end_date, expires_at)
         VALUES ($1,$2,$3,'2027-02-06','2027-02-07','2027-03-01')`,
        [T, r, th],
      );
    await ins(a);
    await expect(ins(b)).rejects.toThrow(/holds_no_overlap/);
  });

  it("concurrent placeHold calls for one date: exactly one wins", async () => {
    const r = await resource();
    const threads = await Promise.all([thread(), thread(), thread()]);
    const results = await Promise.all(threads.map((th) => withTenant(db.pool, T, (c) => nativeAvailability.placeHold(c, hold(T, r, th, "2027-02-13")))));
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok)).toHaveLength(2);
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM holds WHERE resource_id=$1 AND status='active'", [r]);
    expect(rows[0].n).toBe(1);
  });

  it("another tenant cannot see or write these rows (RLS)", async () => {
    const r = await resource();
    const a = await thread();
    await withTenant(db.pool, T, (c) => nativeAvailability.placeHold(c, hold(T, r, a, "2027-02-20")));
    const seen = await withTenant(db.pool, OTHER, (c) => c.query("SELECT 1 FROM holds"));
    expect(seen.rowCount).toBe(0);
    await expect(
      withTenant(db.pool, OTHER, (c) =>
        c.query("INSERT INTO holds (tenant_id, resource_id, thread_id, start_date, end_date, expires_at) VALUES ($1,$2,$3,'2027-03-01','2027-03-01','2027-04-01')", [T, r, a]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("defaultResource is created once per tenant", async () => {
    const a = await withTenant(db.pool, T, (c) => defaultResource(c, T));
    const b = await withTenant(db.pool, T, (c) => defaultResource(c, T));
    expect(a).toBe(b);
  });
});
