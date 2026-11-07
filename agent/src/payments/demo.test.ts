import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { verifyLedger } from "../ledger/index.js";
import { runFixture } from "../simulator/run-fixture.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { proofForThread } from "./proof.js";

let db: TestDb;
let kernel: KernelBridge;
beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

describe("the ticket's demo: simulated signed webhook flips a thread to collected; proof prints the billable chain", () => {
  it("payment-collected-01", async () => {
    const r = await runFixture("fixtures/payment-collected-01.json", { pool: db.pool });
    expect(r.reply).toMatch(/https:\/\/rzp\.sim\.invalid\/pl_/);
    expect(r.payments).toMatchObject([{ status: "collected" }]);
    const threadId = "tenant-rose-court:thread:payment-collected-01";
    const state = await withTenant(db.pool, "tenant-rose-court", (c) => c.query("SELECT state FROM threads WHERE id=$1", [threadId]));
    expect(state.rows[0].state).toBe("collected");
    const proof = await proofForThread(db.pool, kernel, { tenantId: "tenant-rose-court", threadId });
    expect(proof).toMatchObject({ billable: "yes", reason: "ok", chainVerified: true });
    expect((await verifyLedger(db.pool, kernel)).ok).toBe(true);
  });
});
