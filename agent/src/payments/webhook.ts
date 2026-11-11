/**
 * Payment webhook (T15). THIS FILE IS THE ONLY CODE PATH THAT WRITES A `collected` LEDGER ENTRY (a guard test greps
 * the source tree for it). Order of checks for a `paid` event:
 *   1. signature over the exact raw body (nothing is read, written or recorded for an unsigned/forged request);
 *   2. event id already seen -> ignored (replay);
 *   3. link must be one of this tenant's own payments;
 *   4. amount and currency must equal the payment's (copied from the agent's quote) -> else a `payment_mismatch`
 *      ledger entry and NO collected entry;
 *   5. not already collected -> else flagged;
 *   6. (V11) the quote this payment was issued for must still be valid at the moment the `paid` event arrives, re-checked
 *      here (not only when the customer re-asks for the link, which `requestPaymentLink` already checks) -> if an AGENT
 *      quote (never an `owner_quote`: owner prices have no `validUntil` to lapse) has since expired, a `payment_held_for_review`
 *      ledger entry is written instead and NOTHING collects; `payments.status` moves to `held_for_review` too (deliberately
 *      unlike a mismatch, which leaves `payments.status` alone -- an expired quote, unlike a wrong amount, can never become
 *      valid again, so there is no "a correct retry still collects" path here worth preserving);
 *   7. otherwise: payment -> collected, `collected` ledger entry, thread -> collected, provider_payment_id stamped on the
 *      payment row (V12, so a later refund event can resolve back to this payment), in one transaction.
 *
 * (V12) `failed` and `refunded` events are handled in their own branches below, both ledger-only: no owner-notification
 * channel yet (the same stub posture escalations had before V6 existed), and neither ever confused with `collected` or
 * `payment_mismatch`.
 *   - `failed`: a failed ATTEMPT does not consume the payment link (the customer can usually retry the SAME link), so it
 *     is looked up the same way `paid` is (by `provider_link_id`). A `payment_failed` ledger entry is appended;
 *     `payments.status` and `threads.state` are both left exactly as they were -- closer to `payment_mismatch`'s
 *     precedent than to V11's terminal `held_for_review` one.
 *   - `refunded`: happens AFTER a successful collection, looked up by `provider_payment_id` (a refund's real payload
 *     keys off the ORIGINAL payment id, not the payment link id). A `payment_refunded` ledger entry is appended and
 *     `payments.status` moves to the new terminal `'refunded'` value; `threads.state` is left alone.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import type { ProviderRegistry } from "./registry.js";
import type { PaymentProvider } from "./types.js";

/** A collected thread is terminal (the pipeline reads this; it never writes the state). */
export const isCollectedState = (state: string | undefined): boolean => state === "collected";

export type WebhookResult =
  | { status: "collected"; threadId: string; paymentId: string; amountMinor: number }
  | { status: "duplicate" }
  | { status: "rejected"; reason: "bad_signature" | "unparseable" | "unknown_provider" }
  | { status: "ignored"; reason: "unknown_link" | "not_a_payment_event" | "unknown_payment" }
  | { status: "mismatch"; reason: "amount_mismatch" | "currency_mismatch"; threadId: string; paymentId: string }
  | { status: "held_for_review"; threadId: string; paymentId: string }
  | { status: "failed"; threadId: string; paymentId: string }
  | { status: "refunded"; threadId: string; paymentId: string };

interface PaymentRow {
  id: string;
  thread_id: string;
  quote_ledger_seq: number;
  amount_minor: number;
  currency: string;
  status: string;
}

export async function handleWebhook(
  deps: { pool: Pool; kernel: KernelBridge; payments: PaymentProvider },
  rawBody: string,
  headers: Record<string, string | undefined>,
  now: string,
): Promise<WebhookResult> {
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  if (!deps.payments.verifyWebhook(lower, rawBody, now)) return { status: "rejected", reason: "bad_signature" };
  const ev = deps.payments.parseEvent(rawBody, lower);
  if (!ev) return { status: "rejected", reason: "unparseable" };
  if (ev.kind === "other") return { status: "ignored", reason: "not_a_payment_event" };
  const at = new Date(now).toISOString();
  const provider = deps.payments.name;

  try {
    return await withTenant(deps.pool, ev.tenantId, async (client): Promise<WebhookResult> => {
      // Idempotency key = hash of the SIGNED raw body. The event-id header sits outside the HMAC, so anyone replaying a
      // captured body+signature could pick a fresh header each time; the body they cannot change.
      const eventKey = `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
      const seen = await client.query("SELECT 1 FROM payment_events WHERE tenant_id=$1 AND provider=$2 AND event_id=$3", [ev.tenantId, provider, eventKey]);
      if (seen.rowCount) return { status: "duplicate" };
      const record = (paymentId: string | null, outcome: string, detail: string | null) =>
        client.query(
          "INSERT INTO payment_events (tenant_id, provider, event_id, payment_id, outcome, detail, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [ev.tenantId, provider, eventKey, paymentId, outcome, detail, at],
        );
      // (V12) `refunded` resolves by provider_payment_id (a refund's real payload carries the ORIGINAL payment id,
      // not the payment link id); `paid`/`failed` both resolve by provider_link_id, same as before V12.
      const lookupColumn = ev.kind === "refunded" ? "provider_payment_id" : "provider_link_id";
      const lookupValue = ev.kind === "refunded" ? ev.providerPaymentId : ev.providerLinkId;
      // bigint columns come back as strings: converted with an explicit safe-integer check, never ::int (which overflows at 2^31).
      const raw = (
        await client.query<{ id: string; thread_id: string; quote_ledger_seq: string; amount_minor: string; currency: string; status: string }>(
          `SELECT id, thread_id, quote_ledger_seq::text AS quote_ledger_seq, amount_minor::text AS amount_minor, currency, status
             FROM payments WHERE provider=$1 AND ${lookupColumn}=$2 FOR UPDATE`,
          [provider, lookupValue],
        )
      ).rows[0];
      const pay: PaymentRow | undefined = raw && { ...raw, quote_ledger_seq: Number(raw.quote_ledger_seq), amount_minor: Number(raw.amount_minor) };
      if (pay && (!Number.isSafeInteger(pay.amount_minor) || !Number.isSafeInteger(pay.quote_ledger_seq))) throw new Error("payment amount outside the safe integer range");
      if (!pay) {
        // A signed event naming a tenant that does not exist cannot be recorded (FK): ignore it, nothing to attach it to.
        const unknownReason = ev.kind === "refunded" ? "unknown_payment" : "unknown_link";
        if ((await client.query("SELECT 1 FROM tenants WHERE id=$1", [ev.tenantId])).rowCount) await record(null, unknownReason, lookupValue);
        return { status: "ignored", reason: unknownReason };
      }

      // (V12) `failed`: a failed ATTEMPT does not consume the payment link, so `payments.status` and
      // `threads.state` are both left exactly as they were -- same precedent as `payment_mismatch` below,
      // not V11's terminal `held_for_review` one. No dedupe against "already collected" is needed: a late
      // failed-attempt webhook for an earlier try on an already-collected payment is still informational
      // and safe to log (the idempotency check above already guards against the SAME event replaying).
      if (ev.kind === "failed") {
        await appendEntry(client, deps.kernel, {
          tenantId: ev.tenantId, threadId: pay.thread_id, at, type: "payment_failed",
          payload: {
            paymentId: pay.id, quoteSeq: pay.quote_ledger_seq, provider, providerLinkId: ev.providerLinkId,
            ...(ev.providerPaymentId && { providerPaymentId: ev.providerPaymentId }), eventId: ev.eventId,
            amountMinor: ev.amountMinor, currency: ev.currency,
          },
        });
        await record(pay.id, "failed", null);
        return { status: "failed", threadId: pay.thread_id, paymentId: pay.id };
      }

      // (V12) `refunded`: happens AFTER a successful collection -- a real, final outcome. `payments.status`
      // moves to the new terminal 'refunded' value (so the V12 reconciliation view can read it directly off
      // `payments`); `threads.state` is deliberately left alone (ledger-only for v1, no owner-notification
      // channel yet). Not gated on `pay.status === 'collected'`: a refund event is the provider's own
      // report of a real-world fact, and writing it even when our local status had drifted from 'collected'
      // is exactly what lets the reconciliation view show that drift, rather than silently dropping it.
      if (ev.kind === "refunded") {
        await appendEntry(client, deps.kernel, {
          tenantId: ev.tenantId, threadId: pay.thread_id, at, type: "payment_refunded",
          payload: {
            paymentId: pay.id, quoteSeq: pay.quote_ledger_seq, provider, providerPaymentId: ev.providerPaymentId,
            refundId: ev.refundId, eventId: ev.eventId, amountMinor: ev.amountMinor, currency: ev.currency,
            paymentStatusBeforeRefund: pay.status,
          },
        });
        await client.query("UPDATE payments SET status='refunded' WHERE id=$1", [pay.id]);
        await record(pay.id, "refunded", null);
        return { status: "refunded", threadId: pay.thread_id, paymentId: pay.id };
      }

      // Already collected (this payment or this thread): any further paid event is a duplicate, and writes nothing.
      const th = (await client.query<{ state: string }>("SELECT state FROM threads WHERE id=$1 FOR UPDATE", [pay.thread_id])).rows[0];
      if (pay.status === "collected" || th?.state === "collected") return { status: "duplicate" };
      const flag = async (reason: "amount_mismatch" | "currency_mismatch"): Promise<WebhookResult> => {
        await appendEntry(client, deps.kernel, {
          tenantId: ev.tenantId, threadId: pay.thread_id, at, type: "payment_mismatch",
          payload: { reason, paymentId: pay.id, eventId: ev.eventId, expected: { amountMinor: pay.amount_minor, currency: pay.currency }, received: { amountMinor: ev.amountMinor, currency: ev.currency } },
        });
        await record(pay.id, "mismatch", reason);
        return { status: "mismatch", reason, threadId: pay.thread_id, paymentId: pay.id };
      };
      if (ev.currency !== pay.currency) return flag("currency_mismatch");
      if (ev.amountMinor !== pay.amount_minor) return flag("amount_mismatch");

      const quote = (
        await client.query<{ type: string; rate_card_hash: string | null; valid_until: string | null }>(
          "SELECT type, rate_card_hash, payload->>'validUntil' AS valid_until FROM ledger_entries WHERE seq=$1",
          [pay.quote_ledger_seq],
        )
      ).rows[0];
      // An `owner_quote` has no `validUntil` at all (owner prices don't lapse) -- only an agent `quote` can expire here.
      if (quote?.type === "quote" && quote.valid_until && Date.parse(quote.valid_until) < Date.parse(at)) {
        await appendEntry(client, deps.kernel, {
          tenantId: ev.tenantId, threadId: pay.thread_id, at, type: "payment_held_for_review",
          payload: {
            paymentId: pay.id, quoteSeq: pay.quote_ledger_seq, provider, providerLinkId: ev.providerLinkId,
            providerPaymentId: ev.providerPaymentId, eventId: ev.eventId, amountMinor: pay.amount_minor,
            currency: pay.currency, quoteValidUntil: quote.valid_until,
          },
          ...(quote.rate_card_hash && { rateCardHash: quote.rate_card_hash }),
        });
        await client.query("UPDATE payments SET status='held_for_review' WHERE id=$1", [pay.id]);
        await record(pay.id, "held_for_review", "quote_expired");
        return { status: "held_for_review", threadId: pay.thread_id, paymentId: pay.id };
      }

      await appendEntry(client, deps.kernel, {
        tenantId: ev.tenantId, threadId: pay.thread_id, at, type: "collected",
        payload: { paymentId: pay.id, quoteSeq: pay.quote_ledger_seq, provider, providerLinkId: ev.providerLinkId, providerPaymentId: ev.providerPaymentId, eventId: ev.eventId, amountMinor: pay.amount_minor, currency: pay.currency },
        ...(quote?.rate_card_hash && { rateCardHash: quote.rate_card_hash }),
      });
      // V12: stamps provider_payment_id so a later refund event (keyed off the ORIGINAL payment id, not the
      // link id) can resolve back to this row -- previously only known inside the `collected` ledger payload.
      await client.query("UPDATE payments SET status='collected', collected_at=$2, provider_payment_id=$3 WHERE id=$1", [pay.id, at, ev.providerPaymentId]);
      await client.query("UPDATE threads SET state='collected' WHERE id=$1", [pay.thread_id]);
      await record(pay.id, "collected", null);
      return { status: "collected", threadId: pay.thread_id, paymentId: pay.id, amountMinor: pay.amount_minor };
    });
  } catch (e) {
    // Two deliveries of the same event racing: the loser hits the primary key and its whole transaction rolls back.
    if ((e as { code?: string }).code === "23505" && /payment_events/.test((e as { constraint?: string }).constraint ?? "payment_events")) return { status: "duplicate" };
    throw e;
  }
}

/** The seam behind `POST /webhooks/payments/:provider`: the URL names the provider, whose secret and scheme alone verify the request. */
export async function handleProviderWebhook(
  deps: { pool: Pool; kernel: KernelBridge; providers: ProviderRegistry },
  providerName: string,
  rawBody: string,
  headers: Record<string, string | undefined>,
  now: string,
): Promise<WebhookResult> {
  if (!Object.hasOwn(deps.providers, providerName)) return { status: "rejected", reason: "unknown_provider" };
  return handleWebhook({ pool: deps.pool, kernel: deps.kernel, payments: deps.providers[providerName] as PaymentProvider }, rawBody, headers, now);
}
