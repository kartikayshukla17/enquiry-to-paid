/**
 * Owner takeover and handback (T18). A thread the owner (or a manager) writes to is paused: the agent sends the customer
 * nothing on it, the customer's messages are stored and shown to the owner. It resumes on `handback` or after 12 hours
 * with no message from the owner (a durable timer, run on the injected clock).
 *
 * Lock order, everywhere: the thread's timer row, then the thread row, then the ledger head. The pipeline takes
 * thread -> head and the timer worker takes timer -> thread -> head for this kind, so they cannot deadlock.
 */
import type { PoolClient } from "pg";
import { readKillSwitch } from "../killswitch/index.js";
import type { KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { scheduleTimer } from "../timers/index.js";
import type { Member } from "./members.js";
import type { OwnerMessageResult } from "./handle.js";

export const IDLE_RESUME_HOURS = 12;
const HOUR_MS = 3_600_000;
const TIMER_KIND = "owner_idle_resume" as const;
const NOT_PAUSED = "paused_owner";

/**
 * Could this free text be a price? Deliberately broad (fail closed): a currency marker, an amount word, a number of three
 * or more digits (commas allowed), or a number followed by k / lakh / crore. A hit means: not sent while the kill switch is
 * on, and the job is flagged owner-priced (never billable). Dates like 2026-12-12 also match; that errs on the side of
 * not billing, never of billing a price the agent did not set.
 */
export function looksLikePrice(text: string): boolean {
  return /[₹$€£]|\b(?:rs|inr|rupees?|usd|aed|dirhams?|lakhs?|lacs?|crores?)\b|\d[\d,]{2,}|\d\s*(?:k|l|lakh|lac|cr)\b/i.test(text);
}

type Ctx = { tenant: { id: string; name: string }; member: Member; now: string; opsThreadId: string };

/** R<n> (refusal) or Q<n> (agent or owner quote) -> the thread it sits on. */
export async function resolveThreadByRef(c: PoolClient, tenantId: string, ref: string): Promise<string | undefined> {
  const m = /^([RQ])(\d+)$/.exec(ref);
  if (!m) return undefined;
  const types = m[1] === "R" ? ["refusal"] : ["quote", "owner_quote"];
  return (
    await c.query<{ thread_id: string }>("SELECT thread_id FROM ledger_entries WHERE tenant_id=$1 AND tenant_seq=$2 AND type = ANY($3) AND thread_id IS NOT NULL", [tenantId, Number(m[2]), types])
  ).rows[0]?.thread_id;
}

/** The newest ref on a thread, for telling the owner which conversation a message belongs to. */
export async function threadRef(c: PoolClient, tenantId: string, threadId: string): Promise<string | undefined> {
  const r = (
    await c.query<{ type: string; tenant_seq: number }>(
      "SELECT type, tenant_seq::int AS tenant_seq FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND type IN ('refusal','quote','owner_quote') ORDER BY tenant_seq DESC LIMIT 1",
      [tenantId, threadId],
    )
  ).rows[0];
  return r ? `${r.type === "refusal" ? "R" : "Q"}${r.tenant_seq}` : undefined;
}

const lockTimerThenThread = async (c: PoolClient, tenantId: string, threadId: string) => {
  await c.query("SELECT 1 FROM timers WHERE tenant_id=$1 AND kind=$2 AND subject_id=$3 FOR UPDATE", [tenantId, TIMER_KIND, threadId]);
  return (await c.query<{ state: string; paused_from: string | null }>("SELECT state, paused_from FROM threads WHERE id=$1 FOR UPDATE", [threadId])).rows[0];
};

async function heldSincePause(c: PoolClient, tenantId: string, threadId: string): Promise<number> {
  return (
    await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries
        WHERE tenant_id=$1 AND thread_id=$2 AND type='enquiry' AND payload->>'heldForOwner'='true'
          AND tenant_seq > COALESCE((SELECT max(tenant_seq) FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND type='owner_message' AND payload->>'command'='pause'), 0)`,
      [tenantId, threadId],
    )
  ).rows[0]?.n ?? 0;
}

export async function ownerReplyInTxn(c: PoolClient, kernel: KernelBridge, ctx: Ctx, cmd: { ref: string; text: string }): Promise<OwnerMessageResult> {
  const { tenant, member, now } = ctx;
  const opsRow = (payload: Record<string, unknown>) => appendEntry(c, kernel, { tenantId: tenant.id, threadId: ctx.opsThreadId, at: now, type: "owner_message", payload: { command: "reply", ref: cmd.ref, memberId: member.id, role: member.role, text: cmd.text, ...payload } });
  const threadId = await resolveThreadByRef(c, tenant.id, cmd.ref);
  if (!threadId) return { reply: `I can not find ${cmd.ref} in your ledger.`, customerMessages: [], ledgerRow: await opsRow({ rejected: "unknown_ref" }) };

  const th = await lockTimerThenThread(c, tenant.id, threadId);
  if (!th) return { reply: `I can not find ${cmd.ref} in your ledger.`, customerMessages: [], ledgerRow: await opsRow({ rejected: "unknown_ref" }) };
  const ks = await readKillSwitch(c, tenant.id);
  const priced = looksLikePrice(cmd.text);
  if (ks.on && priced) {
    return { reply: "Kill switch is on; I can not send a price. Turn it off first, or send the message without an amount.", customerMessages: [], ledgerRow: await opsRow({ rejected: "kill_switch", scope: ks.scope }) };
  }
  const base = { tenantId: tenant.id, threadId, at: now, type: "owner_message" as const };
  const who = { memberId: member.id, role: member.role };
  const ledgerRow = await appendEntry(c, kernel, {
    ...base,
    payload: { command: "owner_reply", ...who, ref: cmd.ref, text: cmd.text, customerMessage: cmd.text, ownerPriced: priced, ...(ks.on && { killSwitchOn: true, scope: ks.scope }) },
  });
  const customerMessages = [{ threadId, text: cmd.text }];
  const flag = priced ? " It looks like it has a price in it, so this job is marked as your price and is not billable." : "";
  if (th.state === "collected") {
    // Terminal: the job is paid. The message goes out, the thread stays as it is (the agent already stays silent there).
    return { reply: `Sent to the customer. ${cmd.ref} is already paid, so nothing is paused.${flag}`, customerMessages, ledgerRow };
  }
  const resumeAt = new Date(Date.parse(now) + IDLE_RESUME_HOURS * HOUR_MS).toISOString();
  if (th.state !== NOT_PAUSED) {
    await c.query("UPDATE threads SET state=$2, paused_from=$3 WHERE id=$1", [threadId, NOT_PAUSED, th.state]);
    await appendEntry(c, kernel, { ...base, payload: { command: "pause", ...who, ref: cmd.ref, from: th.state, idleResumeAt: resumeAt } });
  }
  await scheduleTimer(c, { tenantId: tenant.id, kind: TIMER_KIND, subjectId: threadId, runAt: resumeAt });
  return {
    reply: `Sent to the customer. The agent will not reply on ${cmd.ref} now. Say "handback ${cmd.ref}" to give it back, or it goes back by itself ${IDLE_RESUME_HOURS} hours after your last message.${flag}`,
    customerMessages,
    ledgerRow,
  };
}

export async function handbackInTxn(c: PoolClient, kernel: KernelBridge, ctx: Ctx, cmd: { ref?: string }): Promise<OwnerMessageResult> {
  const { tenant, member, now } = ctx;
  const opsRow = (reply: string, payload: Record<string, unknown>) =>
    appendEntry(c, kernel, { tenantId: tenant.id, threadId: ctx.opsThreadId, at: now, type: "owner_message", payload: { command: "handback", ...(cmd.ref && { ref: cmd.ref }), memberId: member.id, role: member.role, ...payload } }).then((ledgerRow) => ({ reply, customerMessages: [], ledgerRow }));
  let threadId: string | undefined;
  if (cmd.ref) {
    threadId = await resolveThreadByRef(c, tenant.id, cmd.ref);
    if (!threadId) return opsRow(`I can not find ${cmd.ref} in your ledger.`, { rejected: "unknown_ref" });
  } else {
    const paused = (await c.query<{ id: string }>("SELECT id FROM threads WHERE tenant_id=$1 AND state=$2 ORDER BY id", [tenant.id, NOT_PAUSED])).rows;
    if (paused.length === 0) return opsRow("Nothing is paused.", { rejected: "nothing_paused" });
    if (paused.length > 1) {
      const refs = (await Promise.all(paused.map((p) => threadRef(c, tenant.id, p.id)))).filter((r): r is string => r !== undefined);
      return opsRow(`More than one conversation is paused: ${refs.join(", ")}. Say which one, for example: handback ${refs[0] ?? "R1"}`, { rejected: "ambiguous" });
    }
    threadId = paused[0]!.id;
  }
  const th = await lockTimerThenThread(c, tenant.id, threadId);
  const ref = cmd.ref ?? (await threadRef(c, tenant.id, threadId)) ?? "this conversation";
  if (th?.state !== NOT_PAUSED) return opsRow(`${ref} is not paused (already handed back, or the agent never paused).`, { rejected: "not_paused" });
  const resumedTo = th.paused_from ?? "open";
  const held = await heldSincePause(c, tenant.id, threadId);
  await c.query("UPDATE threads SET state=$2, paused_from=NULL WHERE id=$1", [threadId, resumedTo]);
  await c.query("UPDATE timers SET status='done', done_at=$4::timestamptz WHERE tenant_id=$1 AND kind=$2 AND subject_id=$3 AND status='pending'", [tenant.id, TIMER_KIND, threadId, new Date(now).toISOString()]);
  const ledgerRow = await appendEntry(c, kernel, {
    tenantId: tenant.id, threadId, at: now, type: "owner_message",
    payload: { command: "handback", by: "owner", memberId: member.id, role: member.role, ref, resumedTo, heldMessages: held },
  });
  const heldNote = held > 0 ? ` ${held} customer message${held === 1 ? "" : "s"} came in while you had it; the agent will answer their next message.` : "";
  return { reply: `Handed ${ref} back to the agent.${heldNote}`, customerMessages: [], ledgerRow };
}

/**
 * The idle timer fired for `threadId`. Resumes only if the thread is still paused and the owner has really been quiet for
 * 12 hours (the owner's latest message, on the injected clock); otherwise reports when to try again. Idempotent.
 */
export async function idleResumeInTxn(c: PoolClient, kernel: KernelBridge, a: { tenantId: string; threadId: string; now: string }): Promise<{ resumed: true } | { resumed: false; retryAt?: string }> {
  const th = (await c.query<{ state: string; paused_from: string | null }>("SELECT state, paused_from FROM threads WHERE id=$1 FOR UPDATE", [a.threadId])).rows[0];
  if (th?.state !== NOT_PAUSED) return { resumed: false };
  const last = (
    await c.query<{ at: Date }>("SELECT max(at) AS at FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND type='owner_message' AND payload->>'command'='owner_reply'", [a.tenantId, a.threadId])
  ).rows[0]?.at;
  const dueMs = (last ? last.getTime() : 0) + IDLE_RESUME_HOURS * HOUR_MS;
  if (last && dueMs > Date.parse(a.now)) return { resumed: false, retryAt: new Date(dueMs).toISOString() };
  const resumedTo = th.paused_from ?? "open";
  const held = await heldSincePause(c, a.tenantId, a.threadId);
  await c.query("UPDATE threads SET state=$2, paused_from=NULL WHERE id=$1", [a.threadId, resumedTo]);
  await appendEntry(c, kernel, {
    tenantId: a.tenantId, threadId: a.threadId, at: a.now, type: "owner_message",
    payload: { command: "idle_resume", by: { system: "timer" }, idleHours: IDLE_RESUME_HOURS, ...(last && { lastOwnerMessageAt: last.toISOString() }), resumedTo, heldMessages: held },
  });
  return { resumed: true };
}
