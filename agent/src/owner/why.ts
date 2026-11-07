import type { PoolClient } from "pg";
import { describeReason } from "../escalation/index.js";
import type { ExtractedFields, RefusalReason } from "../kernel/types.js";
import { formatMoney } from "../pipeline/reply.js";
import { describeAsk } from "./format.js";

interface Row {
  tenant_seq: number;
  thread_id: string | null;
  type: string;
  at: Date;
  hash: string;
  payload: Record<string, unknown>;
  rate_card_hash: string | null;
  fields: Partial<ExtractedFields> | null;
}

const COLS = `l.tenant_seq::int AS tenant_seq, l.thread_id, l.type, l.at, l.hash, l.payload, l.rate_card_hash, t.fields`;
const REF_RE = /^([RQ])(\d+)$/;

/**
 * "Why?" answered from ledger rows only: the reason code, rule gap, rule ids and totals are read back from the stored
 * rows and formatted by code. Nothing here is generated, estimated or remembered. `ref` is `R<n>` (a refusal) or
 * `Q<n>` (a quote, agent or owner); without one the most recent refusal is explained.
 */
export async function explain(client: PoolClient, tenantId: string, ref?: string): Promise<string> {
  let row: Row | undefined;
  if (ref === undefined) {
    row = (
      await client.query<Row>(
        `SELECT ${COLS} FROM ledger_entries l LEFT JOIN threads t ON t.id = l.thread_id
          WHERE l.tenant_id=$1 AND l.type='refusal' AND l.payload->>'reason' <> 'missing_required_field' ORDER BY l.tenant_seq DESC LIMIT 1`,
        [tenantId],
      )
    ).rows[0];
    if (!row) return "There is no refusal to explain yet.";
  } else {
    const m = REF_RE.exec(ref);
    if (!m) return `I do not know the ref ${ref}.`;
    const types = m[1] === "R" ? ["refusal"] : ["quote", "owner_quote"];
    row = (
      await client.query<Row>(
        `SELECT ${COLS} FROM ledger_entries l LEFT JOIN threads t ON t.id = l.thread_id WHERE l.tenant_id=$1 AND l.tenant_seq=$2 AND l.type = ANY($3)`,
        [tenantId, Number(m[2]), types],
      )
    ).rows[0];
    if (!row) return `I can not find ${ref} in your ledger.`;
  }
  const label = `${row.type === "refusal" ? "R" : "Q"}${row.tenant_seq}`;
  const anchor = `Ledger entry ${label}, ${row.at.toISOString()}, hash ${row.hash.slice(0, 12)}.`;
  const asked = row.fields && Object.keys(row.fields).length > 0 ? `They asked: ${describeAsk(row.fields)}` : undefined;

  if (row.type === "refusal") {
    const p = row.payload as { reason: RefusalReason; ruleGap?: string; suggestion?: string };
    return [
      `${label}: the agent did not quote this enquiry.`,
      `Reason: ${describeReason(p.reason)} (${p.reason}).`,
      ...(p.ruleGap ? [`Rule gap: ${p.ruleGap}.`] : []),
      ...(p.suggestion ? [`Suggested next step on your rate card: ${p.suggestion}.`] : []),
      ...(asked ? [asked] : []),
      `Status: ${await statusOf(client, tenantId, row)}`,
      anchor,
    ].join("\n");
  }

  const p = row.payload;
  const cur = String(p.currency);
  if (row.type === "owner_quote") {
    const who = await client.query<{ role: string }>("SELECT role FROM members WHERE id=$1", [p.memberId]);
    return [
      `${label}: a price set by ${who.rows[0] ? `your ${who.rows[0].role}` : "a member"}, not by the agent.`,
      `Total: ${formatMoney(p.total as number, cur)}. It did not come from your rate card, so no rule applies and the job is not billable.`,
      ...(asked ? [asked] : []),
      anchor,
    ].join("\n");
  }
  const lines = (p.lines as { label: string; amount: number; ruleId: string }[]) ?? [];
  const adj = (p.adjustments as { label: string; field: string; from: number; to: number; ruleId: string }[] | undefined) ?? [];
  return [
    `${label}: the agent quoted this from your rate card ${(row.rate_card_hash ?? "").slice(0, 12)}.`,
    ...lines.map((l) => `- ${l.label}: ${formatMoney(l.amount, cur)} (rule ${l.ruleId})`),
    ...adj.map((a) => `- ${a.label}: ${a.field} raised from ${a.from} to ${a.to} (rule ${a.ruleId})`),
    `Total: ${formatMoney(p.total as number, cur)}.`,
    ...(asked ? [asked] : []),
    anchor,
  ].join("\n");
}

async function statusOf(client: PoolClient, tenantId: string, r: Row): Promise<string> {
  const later = (
    await client.query<{ type: string; tenant_seq: number; payload: Record<string, unknown> }>(
      `SELECT type, tenant_seq::int AS tenant_seq, payload FROM ledger_entries
        WHERE tenant_id=$1 AND thread_id=$2 AND tenant_seq > $3 AND type IN ('refusal','owner_quote','quote','owner_message') ORDER BY tenant_seq`,
      [tenantId, r.thread_id, r.tenant_seq],
    )
  ).rows;
  const newer = later.find((x) => x.type === "refusal" || x.type === "quote");
  if (newer) return newer.type === "refusal" ? `the customer wrote again; see R${newer.tenant_seq}.` : `the customer wrote again and the agent quoted (Q${newer.tenant_seq}).`;
  const ownerQuote = later.find((x) => x.type === "owner_quote");
  if (ownerQuote) return `answered with a price of ${formatMoney(ownerQuote.payload.total as number, String(ownerQuote.payload.currency))} (Q${ownerQuote.tenant_seq}).`;
  const cmds = later.filter((x) => x.type === "owner_message").map((x) => x.payload.command);
  if (cmds.includes("decline")) return "declined, the customer was told politely.";
  if (cmds.includes("call_them")) return "marked for a call-back, still open.";
  return "waiting for you.";
}
