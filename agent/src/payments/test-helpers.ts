/** Test-only helpers for the payment tests (FICTIONAL tenants, test secret only, no network). */
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { collectingNotifier } from "../escalation/index.js";
import type { KernelBridge } from "../kernel/index.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { seedApprovedCard } from "../ratecard/legacy.js";
import type { PaymentProvider } from "./types.js";

export const TEST_SECRET = "test-only-webhook-secret-not-real";
const CARD_PATH = fileURLToPath(new URL("../../../rate-cards/fictional-banquet.json", import.meta.url));
export const NOW = "2026-11-07T10:00:00Z";

export async function seedTenant(pool: Pool, kernel: KernelBridge, t: { id: string; name: string }): Promise<unknown> {
  const card = JSON.parse(await readFile(CARD_PATH, "utf8")) as unknown;
  await seedApprovedCard({ pool, kernel }, { tenant: t, card, now: NOW });
  return card;
}

export async function ask(
  pool: Pool,
  kernel: KernelBridge,
  payments: PaymentProvider | undefined,
  t: { id: string; name: string },
  card: unknown,
  threadId: string,
  now = NOW,
) {
  return handleEnquiry(
    { pool, kernel, notifier: collectingNotifier([]), ...(payments && { payments }) },
    { tenant: t, threadId, customerRef: `cust-${threadId}`, rateCard: card, now, availability: { blockedDates: [] }, message: "quote?", fields: { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9000 } },
  );
}

export const sign = (body: string, secret = TEST_SECRET): string => createHmac("sha256", secret).update(body).digest("hex");

/** A Razorpay-shaped `payment_link.paid` event (FICTIONAL ids). */
export function paidEvent(o: { linkId: string; tenantId: string; amount: number; currency?: string; eventId?: string; paymentId?: string }) {
  const body = JSON.stringify({
    entity: "event",
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: o.linkId, amount: o.amount, currency: o.currency ?? "INR", notes: { tenant_id: o.tenantId } } },
      payment: { entity: { id: o.paymentId ?? "pay_sim_0001", amount: o.amount, currency: o.currency ?? "INR" } },
    },
  });
  return { body, headers: { "x-razorpay-signature": sign(body), "x-razorpay-event-id": o.eventId ?? "evt_sim_0001" } };
}

/** A Razorpay-shaped `payment.failed` event (FICTIONAL ids, V12) -- a failed ATTEMPT against a payment
 *  link, which the link itself survives (the customer can usually retry it). */
export function failedEvent(o: { linkId: string; tenantId: string; amount: number; currency?: string; eventId?: string; paymentId?: string }) {
  const body = JSON.stringify({
    entity: "event",
    event: "payment.failed",
    payload: {
      payment_link: { entity: { id: o.linkId, amount: o.amount, currency: o.currency ?? "INR", notes: { tenant_id: o.tenantId } } },
      payment: {
        entity: {
          id: o.paymentId ?? "pay_sim_fail_0001", amount: o.amount, currency: o.currency ?? "INR",
          error_code: "BAD_REQUEST_ERROR", error_description: "FICTIONAL: card declined",
        },
      },
    },
  });
  return { body, headers: { "x-razorpay-signature": sign(body), "x-razorpay-event-id": o.eventId ?? "evt_sim_fail_0001" } };
}

/**
 * A Razorpay-shaped `refund.processed` event (FICTIONAL ids, V12), keyed off `payload.refund.entity` --
 * which real Razorpay carries the ORIGINAL payment id on, not the payment link id (hence `paymentId` here,
 * never a link id). The simulated refund entity also carries `notes.tenant_id` for tenant scoping, a
 * reasonable simulated choice documented in V12's report, not a claim about Razorpay's real refund payload.
 */
export function refundedEvent(o: { paymentId: string; tenantId: string; amount: number; currency?: string; eventId?: string; refundId?: string }) {
  const body = JSON.stringify({
    entity: "event",
    event: "refund.processed",
    payload: {
      refund: { entity: { id: o.refundId ?? "rfnd_sim_0001", payment_id: o.paymentId, amount: o.amount, currency: o.currency ?? "INR", notes: { tenant_id: o.tenantId } } },
    },
  });
  return { body, headers: { "x-razorpay-signature": sign(body), "x-razorpay-event-id": o.eventId ?? "evt_sim_refund_0001" } };
}
