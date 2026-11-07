import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { razorpaySim } from "./razorpay-sim.js";
import { ask, seedTenant, TEST_SECRET } from "./test-helpers.js";

let db: TestDb;
let kernel: KernelBridge;
beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

const T1 = { id: "tenant-pay-one", name: "FICTIONAL: Pay One Banquets" };
const provider = razorpaySim({ webhookSecret: TEST_SECRET });

describe("payment link in the reply", () => {
  it("a quote reply carries a simulated link for exactly the kernel total, in paise, and the link is a ledger entry", async () => {
    const card = await seedTenant(db.pool, kernel, T1);
    const res = await ask(db.pool, kernel, provider, T1, card, "pay-thread-1");
    if (res.outcome.kind !== "quote") throw new Error("expected a quote");
    const m = /https:\/\/rzp\.sim\.invalid\/pl_[a-z0-9]+/.exec(res.reply);
    expect(m).not.toBeNull();
    expect(res.reply).toContain("simulation");
    const pay = await withTenant(db.pool, T1.id, (c) => c.query("SELECT amount_minor::int AS amount, currency, link_url, status FROM payments WHERE thread_id='pay-thread-1'"));
    expect(pay.rows).toEqual([{ amount: res.outcome.total, currency: "INR", link_url: m![0], status: "created" }]);
    const led = await withTenant(db.pool, T1.id, (c) => c.query("SELECT payload FROM ledger_entries WHERE thread_id='pay-thread-1' AND type='payment_link'"));
    expect(led.rows[0]?.payload).toMatchObject({ amountMinor: res.outcome.total, currency: "INR", url: m![0], provider: "razorpay-sim" });
  });

  it("no provider configured: the reply carries no link (existing behaviour unchanged)", async () => {
    const card = await seedTenant(db.pool, kernel, T1);
    const res = await ask(db.pool, kernel, undefined, T1, card, "pay-thread-nolink");
    expect(res.reply).not.toContain("rzp.sim.invalid");
  });
});
