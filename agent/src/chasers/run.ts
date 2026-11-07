/**
 * The timer worker's chaser branch (T19). Everything is decided here, under the thread lock, at send time: a cancellation that
 * happened (or a customer who wrote) after the timer was scheduled is seen now, so scheduling-time checks are never the only guard.
 * The send happens inside the transaction that holds the thread lock and writes the `chaser_sent` entry: a customer message or a
 * stop word racing the send waits for the lock and then sees the outcome, and a failed send rolls everything back (the timer stays due).
 */
import type { PoolClient } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { nativeAvailability } from "../availability/native.js";
import { isCollectedState } from "../payments/webhook.js";
import { readKillSwitch } from "../killswitch/index.js";
import { CHASER_AFTER_HOURS, MAX_CHASERS, cancelChaser, consentOf, plusHours } from "./consent.js";
import { SERVICE_WINDOW_HOURS, chaserParams, renderChaser } from "./templates.js";
import type { ChaserOutbox } from "./types.js";

export type ChaserRun = { sent?: 1 | 2; retryAt?: string };

const HOUR_MS = 3_600_000;

export async function runChaserInTxn(
  c: PoolClient,
  kernel: KernelBridge,
  outbox: ChaserOutbox,
  a: { tenantId: string; threadId: string; now: string },
): Promise<ChaserRun> {
  const th = (await c.query<{ state: string; customer_id: string }>("SELECT state, customer_id FROM threads WHERE id=$1 FOR UPDATE", [a.threadId])).rows[0];
  if (!th) return {};
  const quote = (
    await c.query<{ seq: number; tenant_seq: number; at: Date; payload: { total: number; currency: string; validUntil?: string } }>(
      "SELECT seq::int AS seq, tenant_seq::int AS tenant_seq, at, payload FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND type='quote' ORDER BY tenant_seq DESC LIMIT 1",
      [a.tenantId, a.threadId],
    )
  ).rows[0];
  const cancel = async (reason: string) => {
    await cancelChaser(c, kernel, { tenantId: a.tenantId, threadId: a.threadId, reason, at: a.now, ...(quote && { quoteSeq: quote.tenant_seq }) });
    return {};
  };
  if (!quote) return cancel("no_quote");
  // Every reason a reminder would now be unwelcome or wrong, read fresh under the lock. The first that holds cancels it for good.
  if ((await readKillSwitch(c, a.tenantId)).on) return cancel("kill_switch");
  if (isCollectedState(th.state)) return cancel("payment_collected");
  const ownerSpoke =
    th.state === "paused_owner" ||
    (await c.query("SELECT 1 FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND type='owner_message' AND payload->>'command'='owner_reply' AND tenant_seq > $3 LIMIT 1", [a.tenantId, a.threadId, quote.tenant_seq])).rowCount === 1;
  if (ownerSpoke) return cancel("owner_takeover");
  if ((await c.query("SELECT 1 FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND type='enquiry' AND tenant_seq > $3 LIMIT 1", [a.tenantId, a.threadId, quote.tenant_seq])).rowCount === 1) return cancel("customer_reply");
  if (th.state !== "quoted") return cancel("not_quoted");
  // A lapsed hold is not a reason to stay silent (the text never claims one, and a 12h hold would otherwise kill chaser 1, a 48h hold chaser 2).
  // What matters is whether the quoted date can still be had, read now under the thread lock: cancel only if someone else has taken it.
  const hold = (await c.query<{ resource_id: string; start_date: string; end_date: string; status: string; expires_at: Date }>(
    "SELECT resource_id, start_date::text, end_date::text, status, expires_at FROM holds WHERE tenant_id=$1 AND thread_id=$2 ORDER BY created_at DESC LIMIT 1",
    [a.tenantId, a.threadId],
  )).rows[0];
  const holdLive = hold && hold.status === "active" && hold.expires_at.getTime() > Date.parse(a.now);
  if (hold && hold.status !== "confirmed" && !holdLive) {
    const taken = await nativeAvailability.blockedDates(c, { tenantId: a.tenantId, resourceId: hold.resource_id, from: hold.start_date, to: hold.end_date, now: a.now, ignoreThreadId: a.threadId });
    if (taken.length > 0) return cancel("date_unavailable");
  }
  const validUntil = quote.payload.validUntil;
  if (validUntil && Date.parse(validUntil) <= Date.parse(a.now)) return cancel("quote_expired");
  const cs = await consentOf(c, a.tenantId, th.customer_id);
  if (cs.status !== "granted") return cancel(cs.status === "revoked" ? "consent_revoked" : "no_consent");

  const already = (
    await c.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND type='chaser_sent' AND (payload->>'quoteSeq')::int = $3", [a.tenantId, a.threadId, quote.tenant_seq])
  ).rows[0]!.n;
  if (already >= MAX_CHASERS) return {};
  const n = (already + 1) as 1 | 2;
  const anchor = new Date(Math.max(quote.at.getTime(), Date.parse(cs.at))).toISOString();
  const dueAt = plusHours(anchor, CHASER_AFTER_HOURS[already]!);
  if (Date.parse(a.now) < Date.parse(dueAt)) return { retryAt: dueAt };

  // Inside the customer's 24h service window the reminder is plain templated text; outside it WhatsApp only allows an approved template.
  const last = (
    await c.query<{ at: Date }>(
      `SELECT max(at) AS at FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND (type='enquiry' OR (type='consent' AND payload->>'action'='granted'))`,
      [a.tenantId, a.threadId],
    )
  ).rows[0]?.at;
  const kind = last && Date.parse(a.now) - last.getTime() <= SERVICE_WINDOW_HOURS * HOUR_MS ? "free_text" : "template";
  const business = (await c.query<{ name: string }>("SELECT name FROM tenants WHERE id=$1", [a.tenantId])).rows[0]!.name;
  const link = (await c.query<{ link_url: string }>("SELECT link_url FROM payments WHERE tenant_id=$1 AND quote_ledger_seq=$2 AND status='created'", [a.tenantId, quote.seq])).rows[0]?.link_url;
  const params = chaserParams(business, quote.payload, link);
  const { template, text } = renderChaser(n, params);
  await outbox.send({ tenantId: a.tenantId, threadId: a.threadId, customerId: th.customer_id, n, kind, ...(kind === "template" && { template }), params, text, at: a.now });
  await appendEntry(c, kernel, {
    tenantId: a.tenantId, threadId: a.threadId, at: a.now, type: "chaser_sent",
    payload: { n, quoteSeq: quote.tenant_seq, kind, ...(kind === "template" && { template }), text, params, customerId: th.customer_id, lastCustomerMessageAt: last?.toISOString() ?? null },
  });
  if (n === 1) {
    const next = Math.max(Date.parse(plusHours(anchor, CHASER_AFTER_HOURS[1])), Date.parse(plusHours(a.now, 24)));
    return { sent: 1, retryAt: new Date(next).toISOString() };
  }
  return { sent: 2 };
}
