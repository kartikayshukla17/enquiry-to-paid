/** Test-only: one kit per provider so a single contract suite runs against every PaymentProvider (FICTIONAL ids, test secrets, no network). */
import { createHmac } from "node:crypto";
import type { PaymentProvider } from "./types.js";
import { razorpaySim } from "./razorpay-sim.js";
import { stripePaymentLinksSim } from "./stripe-sim.js";
import { failedEvent as razorpayFailed, NOW, paidEvent as razorpayPaid, refundedEvent as razorpayRefunded, sign as razorpaySign, TEST_SECRET } from "./test-helpers.js";

export interface PaidOpts { linkId: string; tenantId: string; amount: number; currency?: string; eventId?: string; paymentId?: string; now?: string }
/** V12: a refund is keyed off the ORIGINAL payment id, never the link id -- `paymentId` here must be
 *  whatever a prior `kit.paid(...)` call used (its default when omitted, or the explicit one passed). */
export interface RefundOpts { paymentId: string; tenantId: string; amount: number; currency?: string; eventId?: string }
export interface ProviderKit {
  name: string;
  provider: PaymentProvider;
  linkPattern: RegExp;
  /** A correctly signed paid webhook as it would arrive at `now`. */
  paid(o: PaidOpts): { body: string; headers: Record<string, string> };
  /** V12: a correctly signed failed-ATTEMPT webhook (the link is not consumed). */
  failed(o: PaidOpts): { body: string; headers: Record<string, string> };
  /** V12: a correctly signed refund webhook for an already-collected payment. */
  refunded(o: RefundOpts): { body: string; headers: Record<string, string> };
  /** Requests that must all fail verification. */
  forgeries(ev: { body: string; headers: Record<string, string> }): [string, Record<string, string | undefined>, string][];
}

export const STRIPE_TEST_SECRET = "whsec_test_only_not_real_stripe_sim";

export const stripeSign = (body: string, tSec: number, secret = STRIPE_TEST_SECRET): string =>
  `t=${tSec},v1=${createHmac("sha256", secret).update(`${tSec}.${body}`).digest("hex")}`;

export const razorpayKit: ProviderKit = {
  name: "razorpay-sim",
  provider: razorpaySim({ webhookSecret: TEST_SECRET }),
  linkPattern: /https:\/\/rzp\.sim\.invalid\/pl_[a-z0-9]+/,
  paid: (o) => razorpayPaid(o),
  failed: (o) => razorpayFailed(o),
  refunded: (o) => razorpayRefunded(o),
  forgeries: (ev) => [
    ["bad", { ...ev.headers, "x-razorpay-signature": "0".repeat(64) }, ev.body],
    ["missing", {}, ev.body],
    ["wrong key", { "x-razorpay-signature": razorpaySign(ev.body, "another-secret") }, ev.body],
    ["tampered body", ev.headers, ev.body.replace(/"amount":\d+/, '"amount":1')],
  ],
};

/** A Stripe-shaped `checkout.session.completed` for a Payment Link. The event id is INSIDE the signed body. */
export function stripePaid(o: PaidOpts) {
  const body = JSON.stringify({
    id: o.eventId ?? "evt_sim_0001",
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_sim_0001", object: "checkout.session", payment_link: o.linkId, amount_total: o.amount, currency: (o.currency ?? "INR").toLowerCase(), payment_intent: o.paymentId ?? "pi_sim_0001", payment_status: "paid", metadata: { tenant_id: o.tenantId } } },
  });
  return { body, headers: { "stripe-signature": stripeSign(body, Math.floor(Date.parse(o.now ?? NOW) / 1000)) } };
}

/** A Stripe-shaped `checkout.session.async_payment_failed` for a Payment Link (V12) -- the link survives. */
export function stripeFailed(o: PaidOpts) {
  const body = JSON.stringify({
    id: o.eventId ?? "evt_sim_fail_0001",
    object: "event",
    type: "checkout.session.async_payment_failed",
    data: { object: { id: "cs_sim_fail_0001", object: "checkout.session", payment_link: o.linkId, amount_total: o.amount, currency: (o.currency ?? "INR").toLowerCase(), payment_intent: o.paymentId ?? "pi_sim_fail_0001", payment_status: "unpaid", metadata: { tenant_id: o.tenantId } } },
  });
  return { body, headers: { "stripe-signature": stripeSign(body, Math.floor(Date.parse(o.now ?? NOW) / 1000)) } };
}

/**
 * A Stripe-shaped `charge.refunded` event (V12), payload under `data.object` as a Charge, keyed off
 * `payment_intent` (the same id `paid` already stored) and `amount_refunded`/`currency`. `metadata.tenant_id`
 * on the charge is a simulated choice (see V12's report), mirroring `checkout.session.completed`'s own.
 */
export function stripeRefunded(o: RefundOpts) {
  const body = JSON.stringify({
    id: o.eventId ?? "evt_sim_refund_0001",
    object: "event",
    type: "charge.refunded",
    data: { object: { id: "ch_sim_0001", object: "charge", payment_intent: o.paymentId, amount_refunded: o.amount, currency: (o.currency ?? "INR").toLowerCase(), metadata: { tenant_id: o.tenantId } } },
  });
  return { body, headers: { "stripe-signature": stripeSign(body, Math.floor(Date.parse(NOW) / 1000)) } };
}

export const stripeKit: ProviderKit = {
  name: "stripe-sim",
  provider: stripePaymentLinksSim({ webhookSecret: STRIPE_TEST_SECRET }),
  linkPattern: /https:\/\/buy\.stripe\.sim\.invalid\/plink_[a-z0-9]+/,
  paid: stripePaid,
  failed: stripeFailed,
  refunded: stripeRefunded,
  forgeries: (ev) => {
    const t = Math.floor(Date.parse(NOW) / 1000);
    return [
      ["bad", { "stripe-signature": `t=${t},v1=${"0".repeat(64)}` }, ev.body],
      ["missing", {}, ev.body],
      ["wrong key", { "stripe-signature": stripeSign(ev.body, t, "whsec_other") }, ev.body],
      ["tampered body", ev.headers, ev.body.replace(/"amount_total":\d+/, '"amount_total":1')],
    ];
  },
};

export const KITS: ProviderKit[] = [razorpayKit, stripeKit];
