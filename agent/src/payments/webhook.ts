/**
 * Payment webhook (T15). THIS FILE IS THE ONLY CODE PATH THAT WRITES A `collected` LEDGER ENTRY (a guard test greps
 * the source tree for it). Order of checks:
 *   1. signature over the exact raw body (nothing is read, written or recorded for an unsigned/forged request);
 *   2. event id already seen -> ignored (replay);
 *   3. link must be one of this tenant's own payments;
 *   4. amount and currency must equal the payment's (copied from the agent's quote) -> else a `payment_mismatch`
 *      ledger entry and NO collected entry;
 *   5. not already collected -> else flagged;
 *   6. otherwise: payment -> collected, `collected` ledger entry, thread -> collected, in one transaction.
 */
import type { Pool } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import type { PaymentProvider } from "./types.js";

export type WebhookResult =
  | { status: "collected"; threadId: string; paymentId: string; amountMinor: number }
  | { status: "duplicate" }
  | { status: "rejected"; reason: "bad_signature" | "unparseable" }
  | { status: "ignored"; reason: "unknown_link" | "not_a_payment_event" }
  | { status: "mismatch"; reason: "amount_mismatch" | "currency_mismatch" | "already_collected"; threadId: string; paymentId: string };

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
  if (!deps.payments.verifyWebhook(lower["x-razorpay-signature"], rawBody)) return { status: "rejected", reason: "bad_signature" };
  const ev = deps.payments.parseEvent(rawBody, lower);
  if (!ev) return { status: "rejected", reason: "unparseable" };
  if (ev.kind !== "paid") return { status: "ignored", reason: "not_a_payment_event" };
  const at = new Date(now).toISOString();
  const provider = deps.payments.name;

  try {
    return await withTenant(deps.pool, ev.tenantId, async (client): Promise<WebhookResult> => {
      const seen = await client.query("SELECT 1 FROM payment_events WHERE tenant_id=$1 AND provider=$2 AND event_id=$3", [ev.tenantId, provider, ev.eventId]);
      if (seen.rowCount) return { status: "duplicate" };
      const record = (paymentId: string | null, outcome: string, detail: string | null) =>
        client.query(
          "INSERT INTO payment_events (tenant_id, provider, event_id, payment_id, outcome, detail, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [ev.tenantId, provider, ev.eventId, paymentId, outcome, detail, at],
        );
      const pay = (
        await client.query<PaymentRow>(
          `SELECT id, thread_id, quote_ledger_seq::int AS quote_ledger_seq, amount_minor::int AS amount_minor, currency, status
             FROM payments WHERE provider=$1 AND provider_link_id=$2 FOR UPDATE`,
          [provider, ev.providerLinkId],
        )
      ).rows[0];
      if (!pay) {
        await record(null, "unknown_link", ev.providerLinkId);
        return { status: "ignored", reason: "unknown_link" };
      }
      const flag = async (reason: "amount_mismatch" | "currency_mismatch" | "already_collected"): Promise<WebhookResult> => {
        await appendEntry(client, deps.kernel, {
          tenantId: ev.tenantId, threadId: pay.thread_id, at, type: "payment_mismatch",
          payload: { reason, paymentId: pay.id, eventId: ev.eventId, expected: { amountMinor: pay.amount_minor, currency: pay.currency }, received: { amountMinor: ev.amountMinor, currency: ev.currency } },
        });
        await record(pay.id, "mismatch", reason);
        return { status: "mismatch", reason, threadId: pay.thread_id, paymentId: pay.id };
      };
      if (ev.currency !== pay.currency) return flag("currency_mismatch");
      if (ev.amountMinor !== pay.amount_minor) return flag("amount_mismatch");
      const thread = (await client.query<{ state: string }>("SELECT state FROM threads WHERE id=$1 FOR UPDATE", [pay.thread_id])).rows[0];
      if (pay.status === "collected" || thread?.state === "collected") return flag("already_collected");

      const quote = (await client.query<{ rate_card_hash: string | null }>("SELECT rate_card_hash FROM ledger_entries WHERE seq=$1", [pay.quote_ledger_seq])).rows[0];
      await appendEntry(client, deps.kernel, {
        tenantId: ev.tenantId, threadId: pay.thread_id, at, type: "collected",
        payload: { paymentId: pay.id, quoteSeq: pay.quote_ledger_seq, provider, providerLinkId: ev.providerLinkId, providerPaymentId: ev.providerPaymentId, eventId: ev.eventId, amountMinor: pay.amount_minor, currency: pay.currency },
        ...(quote?.rate_card_hash && { rateCardHash: quote.rate_card_hash }),
      });
      await client.query("UPDATE payments SET status='collected', collected_at=$2 WHERE id=$1", [pay.id, at]);
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
