/**
 * Real Stripe adapter (test or live depending on the key). A Payment Link needs a price, which needs a product, so link
 * creation is three idempotent calls. Webhook verification and parsing reuse the documented scheme the simulator implements.
 */
import { stripePaymentLinksSim } from "./stripe-sim.js";
import type { CreateLinkRequest, PaymentLink, PaymentProvider } from "./types.js";

export interface StripeLiveConfig {
  secretKey: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function stripeLive(cfg: StripeLiveConfig): PaymentProvider {
  if (!cfg.secretKey) throw new Error("stripeLive needs a secret key");
  const sim = stripePaymentLinksSim({ webhookSecret: cfg.webhookSecret });
  const f = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl ?? "https://api.stripe.com";
  async function call(path: string, params: Record<string, string>, idem: string): Promise<{ id: string; url?: string }> {
    const res = await f(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": idem },
      body: new URLSearchParams(params).toString(),
    });
    const j = (await res.json().catch(() => ({}))) as { id?: unknown; url?: unknown; error?: { message?: string } };
    if (!res.ok || typeof j.id !== "string") throw new Error(`stripe: ${j.error?.message ?? `HTTP ${res.status}`}`);
    return { id: j.id, ...(typeof j.url === "string" && { url: j.url }) };
  }
  return {
    name: "stripe",
    verifyWebhook: sim.verifyWebhook,
    parseEvent: sim.parseEvent,
    async createPaymentLink(req: CreateLinkRequest): Promise<PaymentLink> {
      if (!Number.isInteger(req.amountMinor) || req.amountMinor <= 0) throw new Error("payment amount must be a positive integer in minor units");
      if (!/^[A-Z]{3}$/.test(req.currency)) throw new Error(`stripe link needs an ISO currency code, got ${req.currency}`);
      const k = req.paymentId;
      const product = await call("/v1/products", { name: req.description.slice(0, 250) }, `${k}:product`);
      const price = await call("/v1/prices", { unit_amount: String(req.amountMinor), currency: req.currency.toLowerCase(), product: product.id }, `${k}:price`);
      const link = await call(
        "/v1/payment_links",
        { "line_items[0][price]": price.id, "line_items[0][quantity]": "1", "metadata[tenant_id]": req.tenantId, "metadata[thread_id]": req.threadId, "metadata[payment_id]": req.paymentId },
        `${k}:link`,
      );
      if (!link.url) throw new Error("stripe: payment link has no url");
      return { providerLinkId: link.id, url: link.url };
    },
  };
}
