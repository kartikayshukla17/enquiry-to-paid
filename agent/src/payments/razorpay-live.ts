/**
 * Real Razorpay adapter (test or live depending on the key). Link creation calls the Payment Links API; webhook
 * verification and parsing are the same documented scheme the simulator already implements, so they are reused.
 * Amounts are integer paise. Errors never include credentials.
 */
import { createHash } from "node:crypto";
import { razorpaySim } from "./razorpay-sim.js";
import type { CreateLinkRequest, PaymentLink, PaymentProvider } from "./types.js";

export interface RazorpayLiveConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function razorpayLive(cfg: RazorpayLiveConfig): PaymentProvider {
  if (!cfg.keyId || !cfg.keySecret) throw new Error("razorpayLive needs a key id and secret");
  const sim = razorpaySim({ webhookSecret: cfg.webhookSecret });
  const f = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl ?? "https://api.razorpay.com";
  return {
    name: "razorpay",
    verifyWebhook: sim.verifyWebhook,
    parseEvent: sim.parseEvent,
    async createPaymentLink(req: CreateLinkRequest): Promise<PaymentLink> {
      if (!Number.isInteger(req.amountMinor) || req.amountMinor <= 0) throw new Error("payment amount must be a positive integer in minor units");
      if (req.currency !== "INR") throw new Error(`razorpay handles INR only here, got ${req.currency}`);
      const res = await f(`${base}/v1/payment_links`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64") },
        body: JSON.stringify({
          amount: req.amountMinor,
          currency: req.currency,
          accept_partial: false,
          // reference_id is capped at 40 chars; the full payment id travels in notes.
          reference_id: createHash("sha256").update(req.paymentId).digest("hex").slice(0, 32),
          description: req.description.slice(0, 250),
          notes: { tenant_id: req.tenantId, thread_id: req.threadId, payment_id: req.paymentId },
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { id?: unknown; short_url?: unknown; error?: { description?: string } };
      if (!res.ok || typeof j.id !== "string" || typeof j.short_url !== "string") throw new Error(`razorpay: ${j.error?.description ?? `HTTP ${res.status}`}`);
      return { providerLinkId: j.id, url: j.short_url };
    },
  };
}
