/** T16 demo + per-tenant provider selection. Seams: handleEnquiry (registry dep), handleProviderWebhook, SQL as e2p_app. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { collectingNotifier } from "../escalation/index.js";
import { verifyLedger } from "../ledger/index.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { proofForThread } from "./proof.js";
import { razorpayKit, stripeKit } from "./provider-kit.js";
import { getTenantPaymentProvider, setTenantPaymentProvider, type ProviderRegistry } from "./registry.js";
import { NOW, seedTenant } from "./test-helpers.js";
import { handleProviderWebhook } from "./webhook.js";

let db: TestDb;
let kernel: KernelBridge;
beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

const IN = { id: "tenant-sel-india", name: "FICTIONAL: Selection India Banquets" };
const GB = { id: "tenant-sel-abroad", name: "FICTIONAL: Selection Abroad Banquets" };
const NONE = { id: "tenant-sel-unset", name: "FICTIONAL: Selection Unconfigured" };
const providers: ProviderRegistry = { "razorpay-sim": razorpayKit.provider, "stripe-sim": stripeKit.provider };
const wh = () => ({ pool: db.pool, kernel, providers });

async function enquire(t: { id: string; name: string }, card: unknown, threadId: string) {
  return handleEnquiry(
    { pool: db.pool, kernel, notifier: collectingNotifier([]), paymentProviders: providers },
    { tenant: t, threadId, customerRef: `cust-${threadId}`, rateCard: card, now: NOW, availability: { blockedDates: [] }, message: "quote?", fields: { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9000 } },
  );
}
const link = async (t: { id: string }, threadId: string) =>
  (await withTenant(db.pool, t.id, (c) => c.query("SELECT provider, provider_link_id, amount_minor::text AS amount FROM payments WHERE thread_id=$1", [threadId]))).rows[0] as { provider: string; provider_link_id: string; amount: string };
const state = (t: { id: string }, threadId: string) =>
  withTenant(db.pool, t.id, async (c) => (await c.query("SELECT state FROM threads WHERE id=$1", [threadId])).rows[0]?.state as string);
const collectedRows = (t: { id: string }, threadId: string) =>
  withTenant(db.pool, t.id, async (c) => (await c.query("SELECT payload FROM ledger_entries WHERE thread_id=$1 AND type='collected'", [threadId])).rows);

describe("the ticket's demo: two tenants, two providers, each collects through its own signed webhook", () => {
  it("each tenant's quote carries its own provider's link; each flips to collected only via its own provider's webhook; cross-provider and wrong-secret are rejected", async () => {
    const card = await seedTenant(db.pool, kernel, IN);
    await seedTenant(db.pool, kernel, GB);
    await setTenantPaymentProvider(db.pool, IN.id, "razorpay-sim");
    await setTenantPaymentProvider(db.pool, GB.id, "stripe-sim");
    const a = await enquire(IN, card, "sel-in-1");
    const b = await enquire(GB, card, "sel-gb-1");
    if (a.outcome.kind !== "quote" || b.outcome.kind !== "quote") throw new Error("expected quotes");
    expect(razorpayKit.linkPattern.test(a.reply)).toBe(true);
    expect(stripeKit.linkPattern.test(a.reply)).toBe(false);
    expect(stripeKit.linkPattern.test(b.reply)).toBe(true);
    expect(razorpayKit.linkPattern.test(b.reply)).toBe(false);
    const la = await link(IN, "sel-in-1");
    const lb = await link(GB, "sel-gb-1");
    expect([la.provider, lb.provider]).toEqual(["razorpay-sim", "stripe-sim"]);

    const evIn = razorpayKit.paid({ linkId: la.provider_link_id, tenantId: IN.id, amount: a.outcome.total });
    const evGb = stripeKit.paid({ linkId: lb.provider_link_id, tenantId: GB.id, amount: b.outcome.total });

    // cross-provider: each body+signature posted to the OTHER provider's endpoint is rejected
    expect(await handleProviderWebhook(wh(), "stripe-sim", evIn.body, evIn.headers, NOW)).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(await handleProviderWebhook(wh(), "razorpay-sim", evGb.body, evGb.headers, NOW)).toEqual({ status: "rejected", reason: "bad_signature" });
    // wrong secret on the right endpoint
    const forged = razorpayKit.forgeries(evIn).find(([n]) => n === "wrong key")!;
    expect(await handleProviderWebhook(wh(), "razorpay-sim", forged[2], forged[1], NOW)).toEqual({ status: "rejected", reason: "bad_signature" });
    const forgedS = stripeKit.forgeries(evGb).find(([n]) => n === "wrong key")!;
    expect(await handleProviderWebhook(wh(), "stripe-sim", forgedS[2], forgedS[1], NOW)).toEqual({ status: "rejected", reason: "bad_signature" });
    // an endpoint that is not a configured provider
    expect(await handleProviderWebhook(wh(), "paypal-sim", evIn.body, evIn.headers, NOW)).toEqual({ status: "rejected", reason: "unknown_provider" });
    expect([await state(IN, "sel-in-1"), await state(GB, "sel-gb-1")]).toEqual(["quoted", "quoted"]);

    // the genuine deliveries collect
    expect((await handleProviderWebhook(wh(), "razorpay-sim", evIn.body, evIn.headers, NOW)).status).toBe("collected");
    expect((await handleProviderWebhook(wh(), "stripe-sim", evGb.body, evGb.headers, NOW)).status).toBe("collected");
    expect([await state(IN, "sel-in-1"), await state(GB, "sel-gb-1")]).toEqual(["collected", "collected"]);
    expect((await collectedRows(IN, "sel-in-1"))[0].payload).toMatchObject({ provider: "razorpay-sim" });
    expect((await collectedRows(GB, "sel-gb-1"))[0].payload).toMatchObject({ provider: "stripe-sim" });
    for (const [t, th] of [[IN, "sel-in-1"], [GB, "sel-gb-1"]] as const) {
      expect(await proofForThread(db.pool, kernel, { tenantId: t.id, threadId: th })).toMatchObject({ billable: "yes", reason: "ok", chainVerified: true });
    }
    expect((await verifyLedger(db.pool, kernel)).ok).toBe(true);
  });

  it("a validly signed event from the wrong provider for a tenant's link finds no such link: tenant on Razorpay cannot be collected through Stripe", async () => {
    const card = await seedTenant(db.pool, kernel, IN);
    const r = await enquire(IN, card, "sel-in-2");
    if (r.outcome.kind !== "quote") throw new Error("expected quote");
    const l = await link(IN, "sel-in-2");
    const ev = stripeKit.paid({ linkId: l.provider_link_id, tenantId: IN.id, amount: r.outcome.total });
    expect(await handleProviderWebhook(wh(), "stripe-sim", ev.body, ev.headers, NOW)).toEqual({ status: "ignored", reason: "unknown_link" });
    expect(await state(IN, "sel-in-2")).toBe("quoted");
    expect(await collectedRows(IN, "sel-in-2")).toEqual([]);
  });

  it("a tenant with no provider configured gets a quote with no link", async () => {
    const card = await seedTenant(db.pool, kernel, NONE);
    const r = await enquire(NONE, card, "sel-none-1");
    expect(r.outcome.kind).toBe("quote");
    expect(r.reply).not.toMatch(/sim\.invalid/);
    expect((await withTenant(db.pool, NONE.id, (c) => c.query("SELECT 1 FROM payments"))).rowCount).toBe(0);
  });
});

describe("tenant_payment_config", () => {
  it("is tenant-scoped: a tenant reads only its own row and cannot write another tenant's", async () => {
    await seedTenant(db.pool, kernel, IN);
    await seedTenant(db.pool, kernel, GB);
    await setTenantPaymentProvider(db.pool, IN.id, "razorpay-sim");
    await setTenantPaymentProvider(db.pool, GB.id, "stripe-sim");
    const seen = await withTenant(db.pool, IN.id, (c) => c.query("SELECT tenant_id, provider FROM tenant_payment_config"));
    expect(seen.rows).toEqual([{ tenant_id: IN.id, provider: "razorpay-sim" }]);
    await expect(withTenant(db.pool, IN.id, (c) => c.query("INSERT INTO tenant_payment_config (tenant_id, provider, updated_at) VALUES ($1,'stripe-sim',now())", [NONE.id]))).rejects.toThrow(/row-level security/);
    await withTenant(db.pool, IN.id, (c) => c.query("UPDATE tenant_payment_config SET provider='stripe-sim' WHERE tenant_id=$1", [GB.id]));
    expect(await withTenant(db.pool, GB.id, (c) => getTenantPaymentProvider(c, GB.id))).toBe("stripe-sim");
    expect(await withTenant(db.pool, IN.id, (c) => getTenantPaymentProvider(c, IN.id))).toBe("razorpay-sim");
  });

  it("only known providers can be stored, and switching later keeps old links collectable", async () => {
    await expect(setTenantPaymentProvider(db.pool, IN.id, "paypal-sim")).rejects.toThrow();
    const card = await seedTenant(db.pool, kernel, IN);
    await setTenantPaymentProvider(db.pool, IN.id, "razorpay-sim");
    const r = await enquire(IN, card, "sel-in-3");
    if (r.outcome.kind !== "quote") throw new Error("expected quote");
    const l = await link(IN, "sel-in-3");
    await setTenantPaymentProvider(db.pool, IN.id, "stripe-sim");
    const ev = razorpayKit.paid({ linkId: l.provider_link_id, tenantId: IN.id, amount: r.outcome.total });
    expect((await handleProviderWebhook(wh(), "razorpay-sim", ev.body, ev.headers, NOW)).status).toBe("collected");
  });
});
