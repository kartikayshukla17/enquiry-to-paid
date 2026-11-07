/**
 * Per-job proof (T15): "is this job billable, and why?". Billable only if ALL hold:
 *   - the tenant's hash chain verifies (a tampered ledger vouches for nothing);
 *   - the thread has an agent-issued quote (a `quote` ledger entry with the rate-card hash);
 *   - the job was not priced by the owner (no `owner_message` that set a price);
 *   - a `collected` entry exists (only the webhook writes one), is not corrected away, matches an issued payment link,
 *     and its amount and currency equal that quote's total and currency.
 * The answer is a value (`billable`, a machine `reason`, a human `why`) plus the chain of entries it rests on.
 */
import type { Pool } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { verifyLedger } from "../ledger/index.js";
import { withTenant } from "../tenancy/with-tenant.js";

export type ProofReason =
  | "ok"
  | "unknown_thread"
  | "chain_broken"
  | "no_agent_quote"
  | "owner_priced"
  | "not_collected"
  | "collection_corrected"
  | "no_payment_link"
  | "amount_mismatch";

export interface ProofEntry {
  seq: number;
  tenantSeq: number;
  type: string;
  at: string;
  hash: string;
  summary: string;
}

export interface Proof {
  tenantId: string;
  threadId: string;
  billable: "yes" | "no";
  reason: ProofReason;
  why: string;
  amountMinor?: number;
  currency?: string;
  chainVerified: boolean;
  chain: ProofEntry[];
}

interface Row {
  seq: number;
  tenant_seq: number;
  type: string;
  at: Date;
  hash: string;
  payload: Record<string, unknown>;
  rate_card_hash: string | null;
  corrects: number | null;
}

const money = (minor: unknown, cur: unknown): string => `${String(minor)} minor units ${String(cur)}`;

function summarize(r: Row): string {
  const p = r.payload;
  switch (r.type) {
    case "quote": return `quote total ${money(p.total, p.currency)}, rate card ${(r.rate_card_hash ?? "none").slice(0, 12)}`;
    case "payment_link": return `payment link for ${money(p.amountMinor, p.currency)} (${String(p.provider)})`;
    case "collected": return `collected ${money(p.amountMinor, p.currency)} via ${String(p.provider)} event ${String(p.eventId)}`;
    case "payment_mismatch": return `payment flagged: ${String(p.reason)}`;
    case "correction": return `correction of entry ${String(r.corrects)}`;
    case "owner_message": return `owner message (${String(p.command ?? "text")})`;
    default: return r.type;
  }
}

export async function proofForThread(pool: Pool, kernel: KernelBridge, a: { tenantId: string; threadId: string }): Promise<Proof> {
  const rows = await withTenant(pool, a.tenantId, async (c) =>
    (
      await c.query<Row>(
        `SELECT seq::int AS seq, tenant_seq::int AS tenant_seq, type, at, hash, payload, rate_card_hash, corrects::int AS corrects
           FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 ORDER BY tenant_seq`,
        [a.tenantId, a.threadId],
      )
    ).rows,
  );
  const chain: ProofEntry[] = rows.map((r) => ({ seq: r.seq, tenantSeq: r.tenant_seq, type: r.type, at: r.at.toISOString(), hash: r.hash, summary: summarize(r) }));
  const base = { tenantId: a.tenantId, threadId: a.threadId, chain };
  const no = (reason: ProofReason, why: string, chainVerified: boolean, extra: Partial<Proof> = {}): Proof => ({ ...base, billable: "no", reason, why, chainVerified, ...extra });
  if (rows.length === 0) return no("unknown_thread", "no ledger entries for this thread under this tenant", false);

  const verdict = await verifyLedger(pool, kernel, { tenantId: a.tenantId });
  if (!verdict.ok) return no("chain_broken", `the tenant's ledger chain does not verify (${verdict.reason} at tenant_seq ${verdict.tenantSeq ?? "-"}); nothing on it can be vouched for`, false);

  const quotes = rows.filter((r) => r.type === "quote" && r.rate_card_hash);
  if (quotes.length === 0) return no("no_agent_quote", "the agent never issued a quote on this thread", true);
  const ownerPriced = rows.find((r) => r.type === "owner_message" && (r.payload.command === "price" || r.payload.price !== undefined));
  if (ownerPriced) return no("owner_priced", `the owner set the price (owner message at entry ${ownerPriced.seq}); owner-priced jobs are not billable`, true);

  const collected = rows.find((r) => r.type === "collected");
  if (!collected) return no("not_collected", "no collected entry: payment has not been confirmed by the payment provider's webhook", true);
  if (rows.some((r) => r.type === "correction" && r.corrects === collected.seq)) {
    return no("collection_corrected", `the collected entry ${collected.seq} was corrected afterwards (refund or dispute)`, true);
  }
  const quote = quotes.find((q) => q.seq === collected.payload.quoteSeq);
  if (!quote) return no("no_agent_quote", "the collected entry does not point at an agent-issued quote on this thread", true);
  if (!rows.some((r) => r.type === "payment_link" && r.payload.paymentId === collected.payload.paymentId)) {
    return no("no_payment_link", "no payment link was issued by the agent for the collected payment", true);
  }
  if (quote.payload.total !== collected.payload.amountMinor || quote.payload.currency !== collected.payload.currency) {
    return no("amount_mismatch", `collected ${money(collected.payload.amountMinor, collected.payload.currency)} differs from the quoted ${money(quote.payload.total, quote.payload.currency)}`, true);
  }
  return {
    ...base,
    billable: "yes",
    reason: "ok",
    why: `agent-issued quote (entry ${quote.seq}, rate card ${(quote.rate_card_hash ?? "").slice(0, 12)}) -> payment link -> collected via webhook (entry ${collected.seq}) for exactly the quoted ${money(quote.payload.total, quote.payload.currency)}; not owner-priced; chain verified`,
    amountMinor: collected.payload.amountMinor as number,
    currency: collected.payload.currency as string,
    chainVerified: true,
  };
}
