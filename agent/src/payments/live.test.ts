import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { razorpayLive } from "./razorpay-live.js";
import { stripeLive } from "./stripe-live.js";

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: unknown[], calls: Call[]): typeof fetch {
  let i = 0;
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = responses[i++];
    return new Response(JSON.stringify(body), { status: body && (body as { error?: unknown }).error ? 400 : 200 });
  }) as unknown as typeof fetch;
}
const REQ = { paymentId: "tenant-x:pay:42", tenantId: "tenant-x", threadId: "tenant-x:thread:chat:abc", amountMinor: 610650, currency: "INR", description: "Booking", now: "2026-11-09T10:00:00Z" };

describe("razorpayLive", () => {
  it("creates a payment link with integer paise, tenant notes and basic auth", async () => {
    const calls: Call[] = [];
    const p = razorpayLive({ keyId: "rzp_test_abc", keySecret: "sekret", webhookSecret: "whsec", fetchImpl: fakeFetch([{ id: "plink_123", short_url: "https://rzp.io/i/x" }], calls) });
    const link = await p.createPaymentLink(REQ);
    expect(link).toEqual({ providerLinkId: "plink_123", url: "https://rzp.io/i/x" });
    expect(p.name).toBe("razorpay");
    expect(calls[0]!.url).toBe("https://api.razorpay.com/v1/payment_links");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ amount: 610650, currency: "INR", accept_partial: false, notes: { tenant_id: "tenant-x", thread_id: REQ.threadId, payment_id: REQ.paymentId } });
    expect(body.reference_id.length).toBeLessThanOrEqual(40);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Basic " + Buffer.from("rzp_test_abc:sekret").toString("base64"));
  });

  it("surfaces a provider error without leaking credentials", async () => {
    const p = razorpayLive({ keyId: "rzp_test_abc", keySecret: "sekret", webhookSecret: "w", fetchImpl: fakeFetch([{ error: { description: "Amount too low" } }], []) });
    const err = await p.createPaymentLink(REQ).catch((e: Error) => e);
    expect((err as Error).message).toContain("Amount too low");
    expect((err as Error).message).not.toContain("sekret");
  });

  it("verifies Razorpay's signature scheme over the raw body", () => {
    const p = razorpayLive({ keyId: "k", keySecret: "s", webhookSecret: "whsec", fetchImpl: fakeFetch([], []) });
    const body = '{"event":"payment_link.paid"}';
    const sig = createHmac("sha256", "whsec").update(body).digest("hex");
    expect(p.verifyWebhook({ "x-razorpay-signature": sig }, body, "2026-11-09T10:00:00Z")).toBe(true);
    expect(p.verifyWebhook({ "x-razorpay-signature": sig }, body + " ", "2026-11-09T10:00:00Z")).toBe(false);
  });

  it("refuses non-INR and non-positive amounts before any network call", async () => {
    const calls: Call[] = [];
    const p = razorpayLive({ keyId: "k", keySecret: "s", webhookSecret: "w", fetchImpl: fakeFetch([], calls) });
    await expect(p.createPaymentLink({ ...REQ, currency: "USD" })).rejects.toThrow();
    await expect(p.createPaymentLink({ ...REQ, amountMinor: 0 })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("stripeLive", () => {
  it("creates product, price and payment link with tenant metadata", async () => {
    const calls: Call[] = [];
    const p = stripeLive({ secretKey: "sk_test_abc", webhookSecret: "whsec_x", fetchImpl: fakeFetch([{ id: "prod_1" }, { id: "price_1" }, { id: "plink_9", url: "https://buy.stripe.com/test_abc" }], calls) });
    const link = await p.createPaymentLink(REQ);
    expect(link).toEqual({ providerLinkId: "plink_9", url: "https://buy.stripe.com/test_abc" });
    expect(p.name).toBe("stripe");
    expect(calls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/products", "https://api.stripe.com/v1/prices", "https://api.stripe.com/v1/payment_links"]);
    const price = new URLSearchParams(calls[1]!.init.body as string);
    expect(price.get("unit_amount")).toBe("610650");
    expect(price.get("currency")).toBe("inr");
    expect(price.get("product")).toBe("prod_1");
    const pl = new URLSearchParams(calls[2]!.init.body as string);
    expect(pl.get("line_items[0][price]")).toBe("price_1");
    expect(pl.get("metadata[tenant_id]")).toBe("tenant-x");
    expect(pl.get("metadata[payment_id]")).toBe(REQ.paymentId);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_abc");
  });

  it("verifies Stripe's timestamped signature and rejects stale ones", () => {
    const p = stripeLive({ secretKey: "sk_test_abc", webhookSecret: "whsec_x", fetchImpl: fakeFetch([], []) });
    const body = '{"id":"evt_1"}';
    const t = Math.floor(Date.parse("2026-11-09T10:00:00Z") / 1000);
    const hdr = (ts: number) => `t=${ts},v1=${createHmac("sha256", "whsec_x").update(`${ts}.${body}`).digest("hex")}`;
    expect(p.verifyWebhook({ "stripe-signature": hdr(t) }, body, "2026-11-09T10:00:30Z")).toBe(true);
    expect(p.verifyWebhook({ "stripe-signature": hdr(t - 3600) }, body, "2026-11-09T10:00:30Z")).toBe(false);
  });

  it("surfaces a Stripe error without leaking the key", async () => {
    const p = stripeLive({ secretKey: "sk_test_abc", webhookSecret: "w", fetchImpl: fakeFetch([{ error: { message: "Invalid currency" } }], []) });
    const err = (await p.createPaymentLink(REQ).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("Invalid currency");
    expect(err.message).not.toContain("sk_test_abc");
  });
});
