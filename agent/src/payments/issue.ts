/**
 * Issuing a payment link (T15). Code only: the link text is appended to the reply by the pipeline, never written by a
 * model. A link is issued for an agent-issued quote's exact total (integer paise from the kernel), at most one per quote,
 * and never while the kill switch (global or tenant) is on: the flag is re-read here, inside the caller's transaction.
 */
import type { Pool, PoolClient } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { readKillSwitch } from "../killswitch/index.js";
import { appendEntry } from "../ledger/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import type { PaymentProvider } from "./types.js";

export interface IssuedLink {
  paymentId: string;
  url: string;
  amountMinor: number;
  currency: string;
  /** The reply text the pipeline appends (code-written). */
  replyText: string;
}

export type IssueResult = { ok: true; link: IssuedLink } | { ok: false; reason: "kill_switch" | "no_quote" | "quote_expired" | "not_collectible" };

export const linkReplyText = (url: string, simulated = true): string =>
  simulated ? `To confirm your booking, pay securely here (simulation, no real payment): ${url}` : `To confirm your booking, pay securely here (test mode, use test cards only): ${url}`;

interface QuoteRef {
  seq: number;
  amountMinor: number;
  currency: string;
}

/** Inside a tenant transaction. The caller has just written (or looked up) the quote ledger row `quote`. */
export async function issuePaymentLinkInTxn(
  client: PoolClient,
  kernel: KernelBridge,
  provider: PaymentProvider,
  a: { tenantId: string; threadId: string; quote: QuoteRef; now: string },
): Promise<IssueResult> {
  if ((await readKillSwitch(client, a.tenantId)).on) return { ok: false, reason: "kill_switch" };
  if (!Number.isInteger(a.quote.amountMinor) || a.quote.amountMinor <= 0) return { ok: false, reason: "not_collectible" };
  const paymentId = `${a.tenantId}:pay:${a.quote.seq}`;
  const existing = (await client.query<{ link_url: string }>("SELECT link_url FROM payments WHERE id = $1", [paymentId])).rows[0];
  if (existing) {
    return { ok: true, link: { paymentId, url: existing.link_url, amountMinor: a.quote.amountMinor, currency: a.quote.currency, replyText: linkReplyText(existing.link_url, provider.name.endsWith("-sim")) } };
  }
  const link = await provider.createPaymentLink({
    paymentId,
    tenantId: a.tenantId,
    threadId: a.threadId,
    amountMinor: a.quote.amountMinor,
    currency: a.quote.currency,
    description: `Booking ${a.threadId}`,
    now: a.now,
  });
  await client.query(
    `INSERT INTO payments (id, tenant_id, thread_id, quote_ledger_seq, provider, provider_link_id, link_url, amount_minor, currency, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'created',$10)`,
    [paymentId, a.tenantId, a.threadId, a.quote.seq, provider.name, link.providerLinkId, link.url, a.quote.amountMinor, a.quote.currency, new Date(a.now).toISOString()],
  );
  await appendEntry(client, kernel, {
    tenantId: a.tenantId,
    threadId: a.threadId,
    at: a.now,
    type: "payment_link",
    payload: { paymentId, quoteSeq: a.quote.seq, provider: provider.name, providerLinkId: link.providerLinkId, url: link.url, amountMinor: a.quote.amountMinor, currency: a.quote.currency },
  });
  return { ok: true, link: { paymentId, url: link.url, amountMinor: a.quote.amountMinor, currency: a.quote.currency, replyText: linkReplyText(link.url, provider.name.endsWith("-sim")) } };
}

/**
 * Standalone seam: (re)issue the link for a thread's latest agent-issued quote, e.g. when the customer asks for the link
 * again. Honours the kill switch and the quote's validity.
 */
export async function requestPaymentLink(
  deps: { pool: Pool; kernel: KernelBridge; payments: PaymentProvider },
  a: { tenantId: string; threadId: string; now: string },
): Promise<IssueResult> {
  return withTenant(deps.pool, a.tenantId, async (client) => {
    if ((await readKillSwitch(client, a.tenantId)).on) return { ok: false, reason: "kill_switch" } as const;
    const q = (
      await client.query<{ seq: number; payload: { total?: unknown; currency?: unknown; validUntil?: unknown } }>(
        "SELECT seq::float8 AS seq, payload FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND type='quote' ORDER BY tenant_seq DESC LIMIT 1",
        [a.tenantId, a.threadId],
      )
    ).rows[0];
    if (!q || typeof q.payload.total !== "number" || typeof q.payload.currency !== "string") return { ok: false, reason: "no_quote" } as const;
    if (typeof q.payload.validUntil === "string" && Date.parse(q.payload.validUntil) < Date.parse(a.now)) return { ok: false, reason: "quote_expired" } as const;
    return issuePaymentLinkInTxn(client, deps.kernel, deps.payments, { tenantId: a.tenantId, threadId: a.threadId, quote: { seq: q.seq, amountMinor: q.payload.total, currency: q.payload.currency }, now: a.now });
  });
}
