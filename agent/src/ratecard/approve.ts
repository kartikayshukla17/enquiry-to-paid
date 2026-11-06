/**
 * Approval flow (T14): the owner confirms a compiled card by reading back worked examples priced by the kernel.
 *
 * `startApproval` builds 3 to 5 examples straight from the card's own rules (no hand-written numbers, no LLM) and
 * stores them with the revision; `submitApproval` takes one yes/no per example. Only all-yes by an owner or manager
 * approves; any no leaves the revision a draft with the reason recorded. Both outcomes are ledger entries.
 */
import type { PoolClient } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import type { Outcome, Quote } from "../kernel/types.js";
import { appendEntry } from "../ledger/index.js";
import { formatMoney } from "../pipeline/reply.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { CardError, getRevision, latestRevision, REVISION_COLUMNS, toRevision, type CardRevision, type Deps } from "./store.js";

export interface Readback {
  id: string;
  fields: Record<string, string | number>;
  /** The question put to the owner; every number in it is kernel output. */
  text: string;
  total: number;
  currency: string;
  lines: { label: string; amount: number; ruleId: string }[];
  /** Rule ids that priced this example. */
  ruleIds: string[];
}

type Val = string | number;
type Cond =
  | { op: "eq"; field: string; value: Val }
  | { op: "in"; field: string; values: Val[] }
  | { op: "range"; field: string; min: number | null; max: number | null }
  | { op: "weekday_in"; field: string; days: string[] }
  | { op: "month_in"; field: string; months: number[] };
interface RuleView { ruleId: string; core?: boolean; when: Cond[] }

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Pick = "mid" | "min" | "max";

/** A date at least 14 days after `now` that satisfies every weekday and month class, scanning forward; deterministic. */
function pickDate(conds: Cond[], now: string): string | undefined {
  const start = Date.parse(now.slice(0, 10) + "T00:00:00Z") + 14 * 86_400_000;
  for (let i = 0; i < 800; i++) {
    const d = new Date(start + i * 86_400_000);
    const ok = conds.every((c) => (c.op === "weekday_in" ? c.days.includes(WEEKDAYS[d.getUTCDay()] as string) : c.op === "month_in" ? c.months.includes(d.getUTCMonth() + 1) : true));
    if (ok) return d.toISOString().slice(0, 10);
  }
  return undefined;
}

/** Fields that satisfy every condition at once, or undefined if they contradict. Pure and deterministic. */
function solve(conds: Cond[], pick: Pick, now: string): Record<string, Val> | undefined {
  const byField = new Map<string, Cond[]>();
  for (const c of conds) byField.set(c.field, [...(byField.get(c.field) ?? []), c]);
  const out: Record<string, Val> = {};
  for (const [field, cs] of byField) {
    if (cs.some((c) => c.op === "weekday_in" || c.op === "month_in")) {
      const d = pickDate(cs, now);
      if (d === undefined) return undefined;
      out[field] = d;
      continue;
    }
    let lo: number | null = null;
    let hi: number | null = null;
    let allowed: Val[] | undefined;
    for (const c of cs) {
      if (c.op === "range") {
        if (c.min !== null) lo = lo === null ? c.min : Math.max(lo, c.min);
        if (c.max !== null) hi = hi === null ? c.max : Math.min(hi, c.max);
      } else if (c.op === "eq" || c.op === "in") {
        const vals = c.op === "eq" ? [c.value] : c.values;
        allowed = allowed === undefined ? vals : allowed.filter((v) => vals.includes(v));
      }
    }
    if (lo !== null && hi !== null && lo > hi) return undefined;
    const inRange = (v: Val) => typeof v === "number" && (lo === null || v >= lo) && (hi === null || v <= hi);
    if (allowed !== undefined) {
      const v = allowed.find((a) => (lo === null && hi === null) || inRange(a));
      if (v === undefined) return undefined;
      out[field] = v;
    } else {
      const v = pick === "min" ? (lo ?? hi) : pick === "max" ? (hi ?? lo) : lo !== null && hi !== null ? lo + Math.floor((hi - lo) / 2) : (lo ?? hi);
      if (v === null) return undefined;
      out[field] = v;
    }
  }
  return out;
}

function describe(fields: Record<string, Val>, order: string[]): string {
  const keys = [...order.filter((k) => k in fields), ...Object.keys(fields).filter((k) => !order.includes(k)).sort()];
  return keys
    .map((k) => {
      const v = fields[k] as Val;
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const d = new Date(v + "T00:00:00Z");
        return `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      }
      return `${k} ${v}`;
    })
    .join(", ");
}

/**
 * 3 to 5 worked examples chosen greedily so every rule that can price an enquiry appears in at least one (every core rule
 * and every surcharge). Inputs are solved from the rules' own conditions; the kernel prices them. Same card + same `now`
 * -> same examples.
 */
export function generateReadbacks(kernel: KernelBridge, card: Record<string, unknown>, now: string): Readback[] {
  const rules = card.rules as RuleView[];
  const required = ((card.requiredFields as { field: string }[] | undefined) ?? []).map((f) => f.field);
  const currency = String(card.currency);
  const candidates: Record<string, Val>[] = [];
  const seen = new Set<string>();
  const add = (conds: Cond[], pick: Pick) => {
    const f = solve(conds, pick, now);
    if (!f) return;
    const key = JSON.stringify(Object.entries(f).sort());
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(f);
    }
  };
  const cores = rules.filter((r) => r.core);
  const extras = rules.filter((r) => !r.core);
  for (const c of cores) for (const p of ["mid", "max", "min"] as Pick[]) add(c.when, p);
  for (const c of cores) for (const x of extras) add([...c.when, ...x.when], "mid");

  const priced = candidates.flatMap((fields) => {
    const out = kernel.evaluate({ rateCard: card, fields: { ...fields, language: "en", confidenceBps: 10_000 }, availability: { blockedDates: [] }, now }) as Outcome | { ok: false };
    return "kind" in out && out.kind === "quote" ? [{ fields, quote: out as Quote }] : [];
  });
  if (priced.length === 0) throw new CardError("no_examples", "the kernel prices none of the examples built from this card's rules, so there is nothing to read back");

  const ruleIdsOf = (q: Quote) => q.lines.map((l) => l.ruleId);
  const chosen: typeof priced = [];
  const covered = new Set<string>();
  while (chosen.length < 5) {
    let best: (typeof priced)[number] | undefined;
    let gain = 0;
    for (const p of priced) {
      if (chosen.includes(p)) continue;
      const g = ruleIdsOf(p.quote).filter((id) => !covered.has(id)).length;
      if (g > gain) (best = p), (gain = g);
    }
    if (!best) break;
    chosen.push(best);
    for (const id of ruleIdsOf(best.quote)) covered.add(id);
  }
  for (const p of priced) {
    if (chosen.length >= 3) break;
    if (!chosen.includes(p) && !chosen.some((c) => c.quote.total === p.quote.total)) chosen.push(p);
  }
  for (const p of priced) {
    if (chosen.length >= 3) break;
    if (!chosen.includes(p)) chosen.push(p);
  }

  return chosen.map(({ fields, quote }, i) => {
    const lines = quote.lines.map((l) => ({ label: l.label, amount: l.amount, ruleId: l.ruleId }));
    const itemised = lines.map((l) => `${l.label} ${formatMoney(l.amount, currency)}`).join("; ");
    return {
      id: `rb${i + 1}`,
      fields,
      text: `Example ${i + 1} of ${chosen.length}: ${describe(fields, required)}. Total = ${formatMoney(quote.total, currency)} (${itemised}). Correct?`,
      total: quote.total,
      currency,
      lines,
      ruleIds: ruleIdsOf(quote),
    };
  });
}

/** Generates the read-backs for a revision and stores them with it. Returns what the owner is asked. */
export async function startApproval(
  deps: Deps,
  input: { tenantId: string; cardId: string; version?: number; now: string },
): Promise<{ revision: CardRevision; readbacks: Readback[] }> {
  return withTenant(deps.pool, input.tenantId, async (client) => {
    const rev = await pick(client, input);
    if (rev.status === "approved") throw new CardError("already_approved", `${rev.cardId} revision ${rev.version}`);
    const readbacks = generateReadbacks(deps.kernel, rev.compiled, input.now);
    await client.query("UPDATE rate_cards SET readbacks=$2::jsonb, rejection_reason=NULL WHERE id=$1", [rev.id, JSON.stringify(readbacks)]);
    return { revision: rev, readbacks };
  });
}

async function pick(client: PoolClient, i: { tenantId: string; cardId: string; version?: number }): Promise<CardRevision> {
  const rev = i.version === undefined ? await latestRevision(client, i.tenantId, i.cardId) : await getRevision(client, i.tenantId, i.cardId, i.version);
  if (!rev) throw new CardError("card_not_found", i.cardId);
  return rev;
}

export type Answer = "yes" | "no";
export type ApprovalResult =
  | { approved: true; revision: CardRevision }
  | { approved: false; reasons: string[]; revision: CardRevision };

export async function submitApproval(
  deps: Deps,
  input: { tenantId: string; cardId: string; version: number; memberId: string; answers: Record<string, Answer>; reasons?: Record<string, string>; now: string },
): Promise<ApprovalResult> {
  return withTenant(deps.pool, input.tenantId, async (client) => {
    const member = (await client.query<{ role: string }>("SELECT role FROM members WHERE id=$1", [input.memberId])).rows[0];
    if (!member || (member.role !== "owner" && member.role !== "manager")) throw new CardError("not_authorised", "only an owner or manager can approve a rate card");
    const row = (await client.query<{ readbacks: Readback[] | null }>("SELECT readbacks FROM rate_cards WHERE tenant_id=$1 AND card_id=$2 AND version=$3 FOR UPDATE", [input.tenantId, input.cardId, input.version])).rows[0];
    const rev = await pick(client, input);
    if (rev.status === "approved") throw new CardError("already_approved", `${rev.cardId} revision ${rev.version}`);
    const readbacks = row?.readbacks;
    if (!readbacks || readbacks.length === 0) throw new CardError("no_readbacks", "start the approval first: the owner must be shown worked examples");

    const missing = readbacks.filter((r) => input.answers[r.id] !== "yes" && input.answers[r.id] !== "no").map((r) => r.id);
    if (missing.length > 0) throw new CardError("readbacks_incomplete", `no yes/no for ${missing.join(", ")}`);

    // The snapshot must still be what was compiled, and the examples must still price the same way.
    if (deps.kernel.rateCardHash(rev.compiled) !== rev.contentHash) throw new CardError("card_hash_mismatch", "stored card no longer matches its hash");
    for (const r of readbacks) {
      const out = deps.kernel.evaluate({ rateCard: rev.compiled, fields: { ...r.fields, language: "en", confidenceBps: 10_000 }, availability: { blockedDates: [] }, now: input.now }) as Outcome | { ok: false };
      if (!("kind" in out) || out.kind !== "quote" || out.total !== r.total) throw new CardError("readback_stale", r.id);
    }

    const base = { tenantId: input.tenantId, threadId: null, at: input.now, rateCardHash: rev.contentHash } as const;
    const noes = readbacks.filter((r) => input.answers[r.id] === "no");
    if (noes.length > 0) {
      const reasons = noes.map((r) => `${r.id}: ${input.reasons?.[r.id] ?? "owner said the total is not correct"}`);
      await client.query("UPDATE rate_cards SET rejection_reason=$2 WHERE id=$1", [rev.id, reasons.join("; ")]);
      await appendEntry(client, deps.kernel, { ...base, type: "rate_card_rejected", payload: { cardId: rev.cardId, version: rev.version, contentHash: rev.contentHash, by: input.memberId, reasons } });
      const after = (await client.query(`SELECT ${REVISION_COLUMNS} FROM rate_cards WHERE id=$1`, [rev.id])).rows[0];
      return { approved: false, reasons, revision: toRevision(after) };
    }

    await client.query("UPDATE rate_cards SET status='superseded' WHERE tenant_id=$1 AND card_id=$2 AND status='approved'", [input.tenantId, input.cardId]);
    const done = (
      await client.query(
        `UPDATE rate_cards SET status='approved', approved_at=$2, approved_by=$3, approved_hash=content_hash, rejection_reason=NULL
         WHERE id=$1 RETURNING ${REVISION_COLUMNS}`,
        [rev.id, new Date(input.now).toISOString(), input.memberId],
      )
    ).rows[0];
    await appendEntry(client, deps.kernel, {
      ...base,
      type: "rate_card_approved",
      payload: { cardId: rev.cardId, version: rev.version, contentHash: rev.contentHash, approvedBy: input.memberId, source: rev.source, readbacks: readbacks.map((r) => ({ id: r.id, fields: r.fields, total: r.total })) },
    });
    return { approved: true, revision: toRevision(done) };
  });
}
