import type { Pool, PoolClient } from "pg";
import { handleOwnerCommand, parseOwnerCommand } from "../availability/commands.js";
import { readKillSwitch } from "../killswitch/index.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { appendEntry, type LedgerRow } from "../ledger/index.js";
import { formatMoney } from "../pipeline/reply.js";
import { encryptPii, phoneHash, piiKeysFromEnv, type PiiKeys } from "../security/pii.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { digestInTxn } from "./digest.js";
import { describeAsk, refOf } from "./format.js";
import { findMemberByPhone, type Member } from "./members.js";
import { parseOwnerReply } from "./parse.js";
import { listOpenRefusals, type OpenRefusal } from "./queue.js";
import { declineMessage, HELP_TEXT, ownerQuoteMessage } from "./templates.js";
import type { CustomerMessage } from "./types.js";
import { handbackInTxn, ownerReplyInTxn } from "./takeover.js";
import { explain } from "./why.js";
import { describeReason } from "../escalation/index.js";

export interface OwnerMessageInput {
  tenant: { id: string; name: string };
  /** The sender's stable reference (a phone number in production); hashed before it touches the DB. */
  senderRef: string;
  text: string;
  now: string;
}

export interface OwnerMessageResult {
  /** The reply to send back to the sender on the owner thread. */
  reply: string;
  /** Customer-bound messages this command caused (code templates only). */
  customerMessages: CustomerMessage[];
  ledgerRow?: LedgerRow;
}

/** Roles that may change prices and customer outcomes. Staff are read-only (digest, why). */
const WRITE_ROLES = new Set(["owner", "manager"]);

/**
 * One message on the owner channel. Block commands go to the T10 handler; everything else is parsed by
 * `parseOwnerReply`. Only a member of THIS tenant (hashed-phone lookup) is served; quote/decline/call-them need owner or
 * manager. Every outcome, denials included, is a ledger entry; the thread's customer is only ever sent a template.
 */
export async function handleOwnerMessage(deps: { pool: Pool; kernel?: KernelBridge; pii?: PiiKeys }, input: OwnerMessageInput): Promise<OwnerMessageResult> {
  if (parseOwnerCommand(input.text)) {
    const r = await handleOwnerCommand(deps, input);
    return { reply: r.reply, customerMessages: [], ...(r.ledgerRow && { ledgerRow: r.ledgerRow }) };
  }
  const kernel = deps.kernel ?? (await loadKernel());
  const pii = deps.pii ?? piiKeysFromEnv();
  const cmd = parseOwnerReply(input.text);
  const { tenant, now } = input;

  return withTenant(deps.pool, tenant.id, async (c) => {
    const threadId = await ensureOpsThread(c, tenant, pii);
    const member = await findMemberByPhone(c, tenant.id, pii, input.senderRef);
    const log = (payload: Record<string, unknown>) =>
      appendEntry(c, kernel, { tenantId: tenant.id, threadId, at: now, type: "owner_message", payload: { text: input.text.trim(), memberId: member?.id ?? null, ...payload } });
    const say = async (reply: string, payload: Record<string, unknown>): Promise<OwnerMessageResult> => ({ reply, customerMessages: [], ledgerRow: await log(payload) });

    if (!member) return say(`This number is not registered as the owner or a manager of ${tenant.name}, so I can not act on that.`, { command: cmd?.kind ?? "unknown", denied: true });
    if (!cmd) return say(HELP_TEXT, { command: "unrecognised" });
    if (cmd.kind === "usage") return say(cmd.error, { command: "usage", error: cmd.error });
    if (cmd.kind === "digest") return say((await digestInTxn(c, tenant, now)).text, { command: "digest" });
    if (cmd.kind === "why") return say(await explain(c, tenant.id, cmd.ref), { command: "why", ...(cmd.ref && { ref: cmd.ref }) });
    if (!WRITE_ROLES.has(member.role)) return say("Sorry, only the owner or a manager can do that. You can ask me for the digest or say why with a ref from an escalation message.", { command: cmd.kind, denied: true, role: member.role });

    const ctx = { tenant, member, now, opsThreadId: threadId };
    if (cmd.kind === "reply") return ownerReplyInTxn(c, kernel, ctx, cmd);
    if (cmd.kind === "handback") return handbackInTxn(c, kernel, ctx, cmd);
    const picked = await pick(c, tenant.id, cmd.ref);
    if (!picked.ok) return say(picked.reply, { command: cmd.kind, rejected: picked.code, ...(cmd.ref && { ref: cmd.ref }) });
    return act(c, kernel, { tenant, member, now, text: input.text.trim(), opsThreadId: threadId }, cmd, picked.item);
  });
}

export async function ensureOpsThread(c: PoolClient, tenant: { id: string; name: string }, pii: PiiKeys): Promise<string> {
  await c.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [tenant.id, tenant.name]);
  const customer = `${tenant.id}:cust:ops`;
  const threadId = `${tenant.id}:thread:ops`;
  await c.query("INSERT INTO customers (id, tenant_id, phone_hash, phone_enc) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING", [customer, tenant.id, phoneHash(pii, `ops:${tenant.id}`), encryptPii(pii, `ops:${tenant.id}`)]);
  await c.query("INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING", [threadId, tenant.id, customer]);
  return threadId;
}

type Picked = { ok: true; item: OpenRefusal } | { ok: false; code: string; reply: string };

/** Which enquiry an action applies to. Never guesses: with several waiting and no ref, it asks. */
async function pick(c: PoolClient, tenantId: string, ref: string | undefined): Promise<Picked> {
  const open = await listOpenRefusals(c, tenantId);
  if (ref !== undefined) {
    if (!ref.startsWith("R")) return { ok: false, code: "not_a_refusal_ref", reply: `${ref} is a quote. Use the R ref from the escalation message, e.g. R12.` };
    const hit = open.find((o) => refOf(o.tenantSeq) === ref);
    return hit ? { ok: true, item: hit } : { ok: false, code: "not_waiting", reply: `${ref} is not waiting for you any more (already answered, or the customer wrote again). Say "digest" to see what is open.` };
  }
  const waiting = open.filter((o) => !o.calledBack);
  const choices = waiting.length > 0 ? waiting : open;
  if (choices.length === 0) return { ok: false, code: "nothing_waiting", reply: "Nothing is waiting for you." };
  if (choices.length > 1) {
    const list = choices.map((o) => `${refOf(o.tenantSeq)} (${describeAsk(o.fields)}; ${describeReason(o.reason)})`).join("; ");
    return { ok: false, code: "ambiguous", reply: `More than one enquiry is waiting: ${list}. Say which one, for example: quote ${refOf(choices[0]!.tenantSeq)} 85000` };
  }
  return { ok: true, item: choices[0] as OpenRefusal };
}

async function cardCurrency(c: PoolClient, tenantId: string): Promise<string> {
  const r = await c.query<{ currency: string | null }>(
    "SELECT compiled->>'currency' AS currency FROM rate_cards WHERE tenant_id=$1 AND status='approved' ORDER BY approved_at DESC NULLS LAST LIMIT 1",
    [tenantId],
  );
  return r.rows[0]?.currency ?? "INR";
}

async function act(
  c: PoolClient,
  kernel: KernelBridge,
  ctx: { tenant: { id: string; name: string }; member: Member; now: string; text: string; opsThreadId: string },
  cmd: Exclude<ReturnType<typeof parseOwnerReply>, undefined | { kind: "usage" } | { kind: "digest" } | { kind: "why" } | { kind: "reply" } | { kind: "handback" }>,
  item: OpenRefusal,
): Promise<OwnerMessageResult> {
  const { tenant, member, now, text } = ctx;
  const ref = refOf(item.tenantSeq);
  const base = { tenantId: tenant.id, threadId: item.threadId, at: now };
  const common = { memberId: member.id, role: member.role, text, ref, refusalTenantSeq: item.tenantSeq, refusalSeq: item.seq };

  // Serialise on the thread so two simultaneous replies cannot both act on one refusal (pick() read before any lock).
  const state = (await c.query<{ state: string }>("SELECT state FROM threads WHERE id=$1 FOR UPDATE", [item.threadId])).rows[0]?.state;
  if (state !== "refused") {
    const ledgerRow = await appendEntry(c, kernel, { ...base, threadId: ctx.opsThreadId, type: "owner_message", payload: { ...common, command: cmd.kind, rejected: "not_waiting" } });
    return { reply: `${ref} is not waiting for you any more (already answered, or the customer wrote again). Say "digest" to see what is open.`, customerMessages: [], ledgerRow };
  }

  if (cmd.kind === "quote") {
    const ks = await readKillSwitch(c, tenant.id);
    if (ks.on) {
      const ledgerRow = await appendEntry(c, kernel, { ...base, threadId: ctx.opsThreadId, type: "owner_message", payload: { ...common, command: "quote", rejected: "kill_switch", scope: ks.scope } });
      return { reply: "Kill switch is on; turn it off to send a price", customerMessages: [], ledgerRow };
    }
    const currency = await cardCurrency(c, tenant.id);
    const customerText = ownerQuoteMessage(tenant.name, cmd.amountMinor, currency);
    const ledgerRow = await appendEntry(c, kernel, {
      ...base, type: "owner_quote",
      payload: { ...common, ownerPriced: true, total: cmd.amountMinor, currency, customerMessage: customerText },
    });
    await c.query("UPDATE threads SET state='quoted' WHERE id=$1", [item.threadId]);
    return { reply: `Done. Sent the customer your price of ${formatMoney(cmd.amountMinor, currency)} for ${ref}. This one is your price, so it is not billable.`, customerMessages: [{ threadId: item.threadId, text: customerText }], ledgerRow };
  }
  if (cmd.kind === "decline") {
    const customerText = declineMessage(tenant.name);
    const ledgerRow = await appendEntry(c, kernel, { ...base, type: "owner_message", payload: { ...common, command: "decline", customerMessage: customerText } });
    await c.query("UPDATE threads SET state='closed' WHERE id=$1", [item.threadId]);
    return { reply: `Done. ${ref} was declined and the customer was told politely.`, customerMessages: [{ threadId: item.threadId, text: customerText }], ledgerRow };
  }
  const ledgerRow = await appendEntry(c, kernel, { ...base, type: "owner_message", payload: { ...common, command: "call_them", followUp: true } });
  return { reply: `Noted. ${ref} is marked for a call-back. The customer has not been sent anything.`, customerMessages: [], ledgerRow };
}
