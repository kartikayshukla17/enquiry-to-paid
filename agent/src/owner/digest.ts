import type { Pool, PoolClient } from "pg";
import { describeReason } from "../escalation/index.js";
import { formatMoney } from "../pipeline/reply.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { describeAsk, refOf } from "./format.js";
import { listOpenRefusals } from "./queue.js";

export interface DigestCounts {
  enquiries: number;
  agentQuotes: number;
  ownerQuotes: number;
  refusals: number;
  collected: { currency: string; count: number; totalMinor: number }[];
  awaitingOwner: number;
  callBacks: number;
}

export interface Digest {
  text: string;
  counts: DigestCounts;
}

const WINDOW_MS = 24 * 3_600_000;
const MAX_LISTED = 5;

/**
 * The daily digest, built purely from ledger and thread rows over the 24 hours up to the injected `now`: every number
 * is a COUNT or SUM over stored rows and is placed into a fixed template by code. Same ledger and same `now` give the
 * same text; nothing reads the system clock and no model is involved.
 */
export async function digestInTxn(client: PoolClient, tenant: { id: string; name: string }, now: string): Promise<Digest> {
  const end = new Date(now).toISOString();
  const start = new Date(Date.parse(now) - WINDOW_MS).toISOString();
  const one = async (sql: string) => Number(((await client.query<{ n: string }>(sql, [tenant.id, start, end])).rows[0] as { n: string }).n);
  const inWindow = "tenant_id=$1 AND at > $2 AND at <= $3";
  const enquiries = await one(`SELECT count(DISTINCT thread_id)::text AS n FROM ledger_entries WHERE ${inWindow} AND type='enquiry'`);
  const agentQuotes = await one(`SELECT count(*)::text AS n FROM ledger_entries WHERE ${inWindow} AND type='quote'`);
  const ownerQuotes = await one(`SELECT count(*)::text AS n FROM ledger_entries WHERE ${inWindow} AND type='owner_quote'`);
  const refusals = await one(`SELECT count(*)::text AS n FROM ledger_entries WHERE ${inWindow} AND type='refusal' AND payload->>'reason' <> 'missing_required_field'`);
  const collected = (
    await client.query<{ currency: string; n: string; total: string }>(
      `SELECT payload->>'currency' AS currency, count(*)::text AS n, sum((payload->>'amountMinor')::bigint)::text AS total
         FROM ledger_entries c WHERE c.tenant_id=$1 AND c.at > $2 AND c.at <= $3 AND c.type='collected'
          AND NOT EXISTS (SELECT 1 FROM ledger_entries x WHERE x.tenant_id=c.tenant_id AND x.type='correction' AND x.corrects=c.seq)
        GROUP BY 1 ORDER BY 1`,
      [tenant.id, start, end],
    )
  ).rows.map((r) => ({ currency: r.currency, count: Number(r.n), totalMinor: Number(r.total) }));
  const open = await listOpenRefusals(client, tenant.id);
  const waiting = open.filter((o) => !o.calledBack);
  const counts: DigestCounts = { enquiries, agentQuotes, ownerQuotes, refusals, collected, awaitingOwner: waiting.length, callBacks: open.length - waiting.length };

  const text = [
    `Daily summary for ${tenant.name}`,
    "Last 24 hours:",
    `- New enquiries: ${enquiries}`,
    `- Quotes sent by the agent: ${agentQuotes}`,
    `- Prices set by you or a manager: ${ownerQuotes}`,
    `- Refusals: ${refusals}`,
    collected.length === 0
      ? "- Collected: nothing yet"
      : `- Collected: ${collected.map((c) => `${c.count} ${c.count === 1 ? "payment" : "payments"}, ${formatMoney(c.totalMinor, c.currency)}`).join("; ")}`,
    waiting.length === 0 ? "Waiting for you: nothing." : `Waiting for you (${waiting.length}):`,
    ...waiting.slice(0, MAX_LISTED).map((o) => `- ${refOf(o.tenantSeq)}: ${describeReason(o.reason)} (${describeAsk(o.fields)})`),
    ...(waiting.length > MAX_LISTED ? [`- and ${waiting.length - MAX_LISTED} more`] : []),
    `Call-backs marked: ${counts.callBacks}`,
  ].join("\n");
  return { text, counts };
}

export function buildDigest(pool: Pool, tenant: { id: string; name: string }, now: string): Promise<Digest> {
  return withTenant(pool, tenant.id, (c) => digestInTxn(c, tenant, now));
}
