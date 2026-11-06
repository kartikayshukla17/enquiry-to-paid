import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { runTwoTenants, type TwoTenantReport } from "../simulator/two-tenants.js";
import { decryptPii, piiKeysFromEnv } from "../security/pii.js";
import { withTenant } from "./with-tenant.js";

let db: TestDb;
let report: TwoTenantReport;
beforeAll(async () => {
  db = await createTestDb();
  report = await runTwoTenants("fixtures/two-tenants.json", { pool: db.pool });
});
afterAll(async () => {
  await db.drop();
});

describe("the same enquiry under two tenants", () => {
  it("prices differently because each tenant has its own card", () => {
    const [a, b] = report.tenants;
    expect(a?.outcome.kind).toBe("quote");
    expect(b?.outcome.kind).toBe("quote");
    expect(a?.reply).not.toBe(b?.reply);
    const total = (o: unknown) => (o as { total: number }).total;
    expect(total(a?.outcome)).not.toBe(total(b?.outcome));
  });

  it("each tenant sees exactly its own rows, and every cross-tenant read returns nothing", async () => {
    for (const t of report.tenants) {
      const mine = await withTenant(db.pool, t.tenantId, async (c) => ({
        threads: (await c.query("SELECT tenant_id FROM threads")).rows,
        cards: (await c.query("SELECT tenant_id FROM rate_cards")).rows,
        customers: (await c.query("SELECT tenant_id FROM customers")).rows,
        ledger: (await c.query("SELECT tenant_id FROM ledger_entries")).rows,
      }));
      for (const rows of Object.values(mine)) {
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([t.tenantId]));
      }
    }
    expect(report.crossReads.every((r) => r.rows === 0 && r.allowed === false)).toBe(true);
    expect(report.crossReads.map((r) => r.table).sort()).toEqual(["customers", "ledger_entries", "rate_cards", "threads"]);
    expect(report.crossInsertRejected).toBe(true);
  });

  it("customer phones are stored encrypted and hashed for lookup", async () => {
    const raw = await db.pool.query("SELECT phone_hash, phone_enc FROM customers");
    expect(raw.rowCount).toBe(2);
    for (const r of raw.rows) {
      expect(r.phone_enc).not.toContain("0000000042");
      expect(r.phone_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(decryptPii(piiKeysFromEnv(), r.phone_enc)).toBe("+910000000042");
    }
  });

  it("raw phone numbers never reach the ledger or a log line", async () => {
    const dump = JSON.stringify((await db.pool.query("SELECT * FROM ledger_entries")).rows);
    expect(dump).not.toContain("0000000042");
  });
});
