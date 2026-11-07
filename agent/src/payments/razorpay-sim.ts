/**
 * SIMULATED Razorpay (India). No network, no real keys: links are deterministic fake URLs on a `.invalid` host, and the
 * webhook signature is Razorpay's documented scheme (hex HMAC-SHA256 of the raw body, header X-Razorpay-Signature,
 * keyed with the webhook secret), so swapping in the real adapter changes only link creation.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CreateLinkRequest, ParsedPaymentEvent, PaymentLink, PaymentProvider } from "./types.js";

export interface RazorpaySimConfig {
  /** Webhook secret. Tests pass a throwaway one; the CLI/demo reads RAZORPAY_WEBHOOK_SECRET or a labelled demo value. */
  webhookSecret: string;
}

/** Demo-only secret for `pnpm sim run`; labelled so nobody mistakes it for a credential. */
export const DEMO_WEBHOOK_SECRET = "demo-only-simulated-secret";

export function razorpaySecretFromEnv(env: Record<string, string | undefined> = process.env): string {
  return env.RAZORPAY_WEBHOOK_SECRET && env.RAZORPAY_WEBHOOK_SECRET !== "" ? env.RAZORPAY_WEBHOOK_SECRET : DEMO_WEBHOOK_SECRET;
}

export function razorpaySim(cfg: RazorpaySimConfig): PaymentProvider {
  if (!cfg.webhookSecret) throw new Error("razorpaySim needs a webhook secret");
  const expected = (rawBody: string): Buffer => createHmac("sha256", cfg.webhookSecret).update(rawBody).digest();
  return {
    name: "razorpay-sim",
    async createPaymentLink(req: CreateLinkRequest): Promise<PaymentLink> {
      if (!Number.isInteger(req.amountMinor) || req.amountMinor <= 0) throw new Error("payment amount must be a positive integer in minor units");
      if (req.currency !== "INR") throw new Error(`razorpay handles INR only here, got ${req.currency}`);
      const id = `pl_${createHash("sha256").update(`${req.tenantId}|${req.paymentId}`).digest("hex").slice(0, 14)}`;
      return { providerLinkId: id, url: `https://rzp.sim.invalid/${id}` };
    },
    verifyWebhook(headers, rawBody) {
      const signature = headers["x-razorpay-signature"];
      if (typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;
      return timingSafeEqual(Buffer.from(signature.toLowerCase(), "hex"), expected(rawBody));
    },
    parseEvent(rawBody, headers): ParsedPaymentEvent | null {
      const eventId = headers["x-razorpay-event-id"];
      if (!eventId) return null;
      let j: unknown;
      try {
        j = JSON.parse(rawBody);
      } catch {
        return null;
      }
      const o = j as { event?: unknown; payload?: { payment_link?: { entity?: { id?: unknown; amount?: unknown; currency?: unknown; notes?: { tenant_id?: unknown } } }; payment?: { entity?: { id?: unknown } } } };
      if (typeof o.event !== "string") return null;
      const link = o.payload?.payment_link?.entity;
      const tenantId = typeof link?.notes?.tenant_id === "string" ? link.notes.tenant_id : undefined;
      if (o.event !== "payment_link.paid") return { kind: "other", eventId, ...(tenantId && { tenantId }), type: o.event };
      const payId = o.payload?.payment?.entity?.id;
      if (!link || typeof link.id !== "string" || !tenantId || typeof payId !== "string" || !Number.isSafeInteger(link.amount) || typeof link.currency !== "string") return null;
      return { kind: "paid", eventId, tenantId, providerLinkId: link.id, providerPaymentId: payId, amountMinor: link.amount as number, currency: link.currency };
    },
  };
}
