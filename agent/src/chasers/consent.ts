/**
 * Consent for chasers (T19). The consent ledger is the only source of truth: a customer has consent only while the newest
 * `consent` entry carrying their id says `granted`. Nothing here reads the system clock; every time is the injected `now`.
 *
 * Lock order, everywhere: the thread's chaser timer row, then the thread row, then the ledger head. The pipeline, the stop
 * handler and the timer worker all follow it, so none of them can deadlock with another.
 */
import type { Pool, PoolClient } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import type { ExtractedFields, TurnOutcome } from "../kernel/types.js";
import { appendEntry, type LedgerRow } from "../ledger/index.js";
import { scheduleTimer } from "../timers/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { classifyCustomerText } from "./words.js";

export const OPT_IN_QUESTION = "Reply YES if you would like up to two reminders about this quote. Reply STOP at any time and I will stop.";
export const CONSENT_THANKS = "Thank you. I will send at most two reminders about this quote. Reply STOP at any time and I will stop.";

export const UNSUBSCRIBED_NOTICE = "You are unsubscribed. I will not send you any more reminders. You can still message me about your enquiry at any time.";

const HOUR_MS = 3_600_000;
/** Hours after the anchor (the quote, or a later grant of consent) at which chaser 1 and chaser 2 are due. Two, then stop. */
export const CHASER_AFTER_HOURS = [24, 72] as const;
export const MAX_CHASERS = CHASER_AFTER_HOURS.length;

export const customerIdOf = (tenantId: string, customerRef: string): string => `${tenantId}:cust:${customerRef}`;
export const plusHours = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * HOUR_MS).toISOString();

export type ConsentState =
  | { status: "none" }
  | { status: "requested" | "granted" | "revoked"; at: string; seq: number; threadId: string | null; source: string | undefined };

export async function consentOf(c: PoolClient, tenantId: string, customerId: string): Promise<ConsentState> {
  const r = (
    await c.query<{ payload: { action: "requested" | "granted" | "revoked"; source?: string }; at: Date; tenant_seq: number; thread_id: string | null }>(
      `SELECT payload, at, tenant_seq::int AS tenant_seq, thread_id FROM ledger_entries
        WHERE tenant_id=$1 AND type='consent' AND payload->>'customerId'=$2 ORDER BY tenant_seq DESC LIMIT 1`,
      [tenantId, customerId],
    )
  ).rows[0];
  return r ? { status: r.payload.action, at: r.at.toISOString(), seq: r.tenant_seq, threadId: r.thread_id, source: r.payload.source } : { status: "none" };
}

/** Read seam for the owner/ops side and for tests: the customer's consent as the ledger currently says it. */
export async function consentStatus(pool: Pool, tenantId: string, customerRef: string): Promise<ConsentState> {
  return withTenant(pool, tenantId, (c) => consentOf(c, tenantId, customerIdOf(tenantId, customerRef)));
}

export function appendConsent(
  c: PoolClient,
  kernel: KernelBridge,
  e: { tenantId: string; threadId: string | null; customerId: string; action: "requested" | "granted" | "revoked"; source: string; at: string; extra?: Record<string, unknown> },
): Promise<LedgerRow> {
  return appendEntry(c, kernel, {
    tenantId: e.tenantId, threadId: e.threadId, at: e.at, type: "consent",
    payload: { action: e.action, customerId: e.customerId, source: e.source, ...e.extra },
  });
}

export async function lockChaserTimer(c: PoolClient, tenantId: string, threadId: string): Promise<void> {
  await c.query("SELECT 1 FROM timers WHERE tenant_id=$1 AND kind='chaser' AND subject_id=$2 FOR UPDATE", [tenantId, threadId]);
}

/** (Re)schedules chaser 1, 24 hours after `anchor`. The count of chasers already sent for the quote is re-checked when it fires. */
export function scheduleChaser(c: PoolClient, tenantId: string, threadId: string, anchor: string): Promise<void> {
  return scheduleTimer(c, { tenantId, kind: "chaser", subjectId: threadId, runAt: plusHours(anchor, CHASER_AFTER_HOURS[0]) });
}

/** Cancels a pending chaser and says why in the ledger. A no-op (no entry) when nothing is pending, so replays write nothing. */
export async function cancelChaser(c: PoolClient, kernel: KernelBridge, a: { tenantId: string; threadId: string; reason: string; at: string; quoteSeq?: number }): Promise<boolean> {
  const done = await c.query(
    "UPDATE timers SET status='done', done_at=$3::timestamptz WHERE tenant_id=$1 AND kind='chaser' AND subject_id=$2 AND status='pending' RETURNING id",
    [a.tenantId, a.threadId, new Date(a.at).toISOString()],
  );
  if (done.rowCount === 0) return false;
  await appendEntry(c, kernel, {
    tenantId: a.tenantId, threadId: a.threadId, at: a.at, type: "chase",
    payload: { action: "cancelled", reason: a.reason, ...(a.quoteSeq !== undefined && { quoteSeq: a.quoteSeq }) },
  });
  return true;
}

export interface ConsentReply {
  reply: string;
  outcome: TurnOutcome;
  ledgerRow: LedgerRow;
  fields: ExtractedFields;
  consent: "granted" | "revoked";
}

const NO_FIELDS = { language: "unknown", confidenceBps: 0 } as ExtractedFields;
const consentOutcome = (gap: string): TurnOutcome => ({ kind: "refusal", reason: "out_of_policy", ruleGap: gap });

/**
 * A customer text that is a consent answer, handled before any extraction (no model sees it). Returns undefined when the text is
 * not one, and the normal pipeline takes it. A "yes" counts only as the answer to a pending opt-in question on the same thread.
 */
export async function handleConsentMessage(
  deps: { pool: Pool; kernel: KernelBridge },
  e: { tenant: { id: string }; threadId: string; customerRef: string; message: string; now: string },
): Promise<ConsentReply | undefined> {
  const word = classifyCustomerText(e.message);
  if (word === undefined) return undefined;
  const customerId = customerIdOf(e.tenant.id, e.customerRef);
  return withTenant(deps.pool, e.tenant.id, async (c): Promise<ConsentReply | undefined> => {
    // All of this customer's chaser timers first (in id order), then this thread, then the ledger head.
    const timers = (
      await c.query<{ subject_id: string }>(
        `SELECT subject_id FROM timers WHERE tenant_id=$1 AND kind='chaser' AND subject_id IN (SELECT id FROM threads WHERE tenant_id=$1 AND customer_id=$2) ORDER BY subject_id FOR UPDATE`,
        [e.tenant.id, customerId],
      )
    ).rows.map((r) => r.subject_id);
    await lockChaserTimer(c, e.tenant.id, e.threadId);
    const th = (await c.query<{ state: string }>("SELECT state FROM threads WHERE id=$1 FOR UPDATE", [e.threadId])).rows[0];
    const cs = await consentOf(c, e.tenant.id, customerId);
    if (word === "yes") {
      if (cs.status !== "requested" || cs.threadId !== e.threadId || !th) return undefined;
      const ledgerRow = await appendConsent(c, deps.kernel, {
        tenantId: e.tenant.id, threadId: e.threadId, customerId, action: "granted", source: "whatsapp_optin_reply", at: e.now, extra: { requestSeq: cs.seq, text: e.message },
      });
      // The clock for the reminders restarts from this answer when it came after the quote was sent.
      if (th.state === "quoted") await scheduleChaser(c, e.tenant.id, e.threadId, e.now);
      return { reply: CONSENT_THANKS, outcome: consentOutcome("consent_granted"), ledgerRow, fields: NO_FIELDS, consent: "granted" };
    }
    // A stop word is honoured whatever else is going on: kill switch, owner takeover, a settled thread. It prices nothing.
    const threadId = th ? e.threadId : null;
    const again = cs.status === "revoked";
    if (!again) await appendConsent(c, deps.kernel, { tenantId: e.tenant.id, threadId, customerId, action: "revoked", source: "stop_word", at: e.now, extra: { text: e.message } });
    const ledgerRow = await appendEntry(c, deps.kernel, {
      tenantId: e.tenant.id, threadId, at: e.now, type: "stop", payload: { customerId, text: e.message, confirmed: !again },
    });
    // Every pending reminder for this customer, on any of their threads, is cancelled now (and would be again at send time).
    for (const t of new Set([...timers, ...(th ? [e.threadId] : [])])) await cancelChaser(c, deps.kernel, { tenantId: e.tenant.id, threadId: t, reason: "stop_word", at: e.now });
    // The customer is told once: a second stop word gets no reply.
    return { reply: again ? "" : UNSUBSCRIBED_NOTICE, outcome: consentOutcome("customer_stop_request"), ledgerRow, fields: NO_FIELDS, consent: "revoked" };
  });
}
