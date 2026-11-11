/**
 * SIMULATED Stripe Payment Links (outside India). No network, no real keys: links are deterministic fake URLs on a
 * `.invalid` host. The webhook scheme is Stripe's documented one: header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]`,
 * v1 = hex HMAC-SHA256 over `${t}.${rawBody}` keyed with the endpoint secret. Replay protection: |now - t| must be within
 * the tolerance, where `now` is the INJECTED clock (never Date.now). The event id lives inside the signed body.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CreateLinkRequest, ParsedPaymentEvent, PaymentLink, PaymentProvider } from "./types.js";

export interface StripeSimConfig {
  webhookSecret: string;
  /** Seconds either side of the injected clock. Stripe's libraries default to 300. */
  toleranceSeconds?: number;
}

export const STRIPE_DEFAULT_TOLERANCE_SECONDS = 300;

export function stripeSecretFromEnv(env: Record<string, string | undefined> = process.env): string {
  return env.STRIPE_WEBHOOK_SECRET && env.STRIPE_WEBHOOK_SECRET !== "" ? env.STRIPE_WEBHOOK_SECRET : "demo-only-simulated-stripe-secret";
}

export function stripePaymentLinksSim(cfg: StripeSimConfig): PaymentProvider {
  if (!cfg.webhookSecret) throw new Error("stripePaymentLinksSim needs a webhook secret");
  const tolerance = cfg.toleranceSeconds ?? STRIPE_DEFAULT_TOLERANCE_SECONDS;
  return {
    name: "stripe-sim",
    async createPaymentLink(req: CreateLinkRequest): Promise<PaymentLink> {
      if (!Number.isInteger(req.amountMinor) || req.amountMinor <= 0) throw new Error("payment amount must be a positive integer in minor units");
      if (!/^[A-Z]{3}$/.test(req.currency)) throw new Error(`stripe link needs an ISO currency code, got ${req.currency}`);
      const id = `plink_${createHash("sha256").update(`stripe|${req.tenantId}|${req.paymentId}`).digest("hex").slice(0, 14)}`;
      return { providerLinkId: id, url: `https://buy.stripe.sim.invalid/${id}` };
    },
    verifyWebhook(headers, rawBody, now) {
      const header = headers["stripe-signature"];
      if (typeof header !== "string") return false;
      let t: number | undefined;
      const sigs: string[] = [];
      for (const part of header.split(",")) {
        const eq = part.indexOf("=");
        if (eq < 0) return false;
        const k = part.slice(0, eq).trim();
        const v = part.slice(eq + 1).trim();
        if (k === "t") {
          if (t !== undefined || !/^\d{1,12}$/.test(v)) return false;
          t = Number(v);
        } else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v.toLowerCase());
      }
      const nowMs = Date.parse(now);
      if (t === undefined || sigs.length === 0 || Number.isNaN(nowMs)) return false;
      if (Math.abs(Math.floor(nowMs / 1000) - t) > tolerance) return false;
      const expected = createHmac("sha256", cfg.webhookSecret).update(`${t}.${rawBody}`).digest();
      let ok = false;
      for (const s of sigs) ok = timingSafeEqual(Buffer.from(s, "hex"), expected) || ok;
      return ok;
    },
    parseEvent(rawBody): ParsedPaymentEvent | null {
      let j: unknown;
      try {
        j = JSON.parse(rawBody);
      } catch {
        return null;
      }
      const o = j as {
        id?: unknown;
        type?: unknown;
        data?: {
          object?: {
            payment_link?: unknown; amount_total?: unknown; currency?: unknown; payment_intent?: unknown;
            payment_status?: unknown; metadata?: { tenant_id?: unknown }; amount_refunded?: unknown;
          };
        };
      };
      if (typeof o.id !== "string" || typeof o.type !== "string") return null;
      const s = o.data?.object;
      const tenantId = typeof s?.metadata?.tenant_id === "string" ? s.metadata.tenant_id : undefined;
      // V12: charge.refunded -- real Stripe Charge object carries `payment_intent` (the same id `paid`
      // already stored as `providerPaymentId`) and `amount_refunded`/`currency`. Tenant scoping via
      // `metadata.tenant_id` on the charge is a simulated choice (see V12's report): Stripe charges do not
      // always inherit the checkout session's metadata, but this simulation puts it there for the same
      // reason `checkout.session.completed` already does.
      if (o.type === "charge.refunded") {
        if (typeof s?.payment_intent !== "string" || !tenantId || !Number.isSafeInteger(s.amount_refunded) || typeof s.currency !== "string") {
          return { kind: "other", eventId: o.id, ...(tenantId && { tenantId }), type: o.type };
        }
        return { kind: "refunded", eventId: o.id, tenantId, providerPaymentId: s.payment_intent, refundId: `${o.id}:refund`, amountMinor: s.amount_refunded as number, currency: s.currency.toUpperCase() };
      }
      // V12: checkout.session.async_payment_failed -- a failed attempt (delayed payment method) against the
      // SAME checkout session/payment link, which is not consumed by the failure. Same `payment_link`/
      // `amount_total`/`currency`/`metadata.tenant_id` shape `checkout.session.completed` already uses.
      if (o.type === "checkout.session.async_payment_failed") {
        if (!s || typeof s.payment_link !== "string" || !tenantId || !Number.isSafeInteger(s.amount_total) || typeof s.currency !== "string") {
          return { kind: "other", eventId: o.id, ...(tenantId && { tenantId }), type: o.type };
        }
        return {
          kind: "failed", eventId: o.id, tenantId, providerLinkId: s.payment_link,
          ...(typeof s.payment_intent === "string" && { providerPaymentId: s.payment_intent }),
          amountMinor: s.amount_total as number, currency: s.currency.toUpperCase(),
        };
      }
      if (o.type !== "checkout.session.completed") return { kind: "other", eventId: o.id, ...(tenantId && { tenantId }), type: o.type };
      // A completed session whose payment is not yet paid (delayed methods) is not money received.
      if (s?.payment_status !== "paid") return { kind: "other", eventId: o.id, ...(tenantId && { tenantId }), type: "checkout.session.completed:unpaid" };
      if (!s || typeof s.payment_link !== "string" || !tenantId || typeof s.payment_intent !== "string" || !Number.isSafeInteger(s.amount_total) || typeof s.currency !== "string") return null;
      return { kind: "paid", eventId: o.id, tenantId, providerLinkId: s.payment_link, providerPaymentId: s.payment_intent, amountMinor: s.amount_total as number, currency: s.currency.toUpperCase() };
    },
  };
}
