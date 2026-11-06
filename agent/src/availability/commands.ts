import type { Pool } from "pg";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { appendEntry, type LedgerRow } from "../ledger/index.js";
import { formatDate } from "../pipeline/reply.js";
import { encryptPii, phoneHash, piiKeysFromEnv, type PiiKeys } from "../security/pii.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { addBlock, defaultResource, listBlocks, removeBlockedDate } from "./native.js";

/**
 * Chat-style owner commands, parsed deterministically (no LLM): the text either matches one of these forms or it is
 * not a command. Dates are ISO (YYYY-MM-DD), so there is nothing to interpret.
 *
 *   block 2026-12-12 hall maintenance
 *   block 2026-12-12 to 2026-12-14 family wedding
 *   unblock 2026-12-12
 *   show blocks
 */
export type OwnerCommand =
  | { kind: "block"; start: string; end: string; reason: string }
  | { kind: "unblock"; date: string }
  | { kind: "show_blocks" }
  | { kind: "usage"; error: string };

const ISO = String.raw`(\d{4}-\d{2}-\d{2})`;
const BLOCK_RE = new RegExp(String.raw`^block\s+${ISO}(?:\s+to\s+${ISO})?(?:\s+(.*))?$`, "i");
const UNBLOCK_RE = new RegExp(String.raw`^unblock\s+${ISO}$`, "i");
const SHOW_RE = /^(?:show|list)\s+blocks$/i;

const validIso = (d: string): boolean => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/** Returns undefined when the text is not a block command at all (it is then an ordinary message). */
export function parseOwnerCommand(text: string): OwnerCommand | undefined {
  const t = text.trim().replace(/\s+/g, " ");
  if (SHOW_RE.test(t)) return { kind: "show_blocks" };
  const u = UNBLOCK_RE.exec(t);
  if (u) return validIso(u[1] as string) ? { kind: "unblock", date: u[1] as string } : { kind: "usage", error: "That is not a real date." };
  if (/^unblock\b/i.test(t)) return { kind: "usage", error: "Say it like: unblock 2026-12-12" };
  const b = BLOCK_RE.exec(t);
  if (b) {
    const start = b[1] as string;
    const end = (b[2] as string | undefined) ?? start;
    if (!validIso(start) || !validIso(end)) return { kind: "usage", error: "That is not a real date." };
    if (end < start) return { kind: "usage", error: "The end date is before the start date." };
    return { kind: "block", start, end, reason: (b[3] ?? "").trim() };
  }
  if (/^block\b/i.test(t)) return { kind: "usage", error: "Say it like: block 2026-12-12 hall maintenance" };
  return undefined;
}

export interface OwnerCommandInput {
  tenant: { id: string; name: string };
  /** The sender's stable reference (a phone number in production); hashed before it touches the DB. */
  senderRef: string;
  text: string;
  now: string;
}

export interface OwnerCommandResult {
  /** False: not a command, route the message elsewhere. */
  handled: boolean;
  reply: string;
  ledgerRow?: LedgerRow;
}

const ALLOWED_ROLES = new Set(["owner", "manager"]);

/**
 * Runs one owner/manager command against the native availability tables. Only members with role owner or manager
 * (looked up in the `members` table by phone hash) may change blocks; anyone else is told no and the attempt is
 * logged. Every handled command appends an `owner_message` ledger entry on the tenant's operations thread.
 */
export async function handleOwnerCommand(
  deps: { pool: Pool; kernel?: KernelBridge; pii?: PiiKeys },
  input: OwnerCommandInput,
): Promise<OwnerCommandResult> {
  const cmd = parseOwnerCommand(input.text);
  if (!cmd) return { handled: false, reply: "" };
  const kernel = deps.kernel ?? (await loadKernel());
  const pii = deps.pii ?? piiKeysFromEnv();
  const { tenant } = input;

  return withTenant(deps.pool, tenant.id, async (client) => {
    await client.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [tenant.id, tenant.name]);
    // The ledger needs a thread; the tenant's operations thread (with a placeholder customer) carries owner activity.
    const opsCustomer = `${tenant.id}:cust:ops`;
    const threadId = `${tenant.id}:thread:ops`;
    await client.query(
      "INSERT INTO customers (id, tenant_id, phone_hash, phone_enc) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
      [opsCustomer, tenant.id, phoneHash(pii, `ops:${tenant.id}`), encryptPii(pii, `ops:${tenant.id}`)],
    );
    await client.query("INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING", [threadId, tenant.id, opsCustomer]);

    const member = (
      await client.query<{ id: string; role: string }>("SELECT id, role FROM members WHERE tenant_id=$1 AND phone_hash=$2", [tenant.id, phoneHash(pii, input.senderRef)])
    ).rows[0];
    const log = (payload: Record<string, unknown>) =>
      appendEntry(client, kernel, { tenantId: tenant.id, threadId, at: input.now, type: "owner_message", payload: { text: input.text.trim(), memberId: member?.id ?? null, ...payload } });

    if (!member || !ALLOWED_ROLES.has(member.role)) {
      const ledgerRow = await log({ command: cmd.kind, denied: true });
      return { handled: true, reply: "Sorry, only the owner or a manager can change blocked dates.", ledgerRow };
    }
    if (cmd.kind === "usage") {
      const ledgerRow = await log({ command: "usage", error: cmd.error });
      return { handled: true, reply: cmd.error, ledgerRow };
    }

    const today = new Date(input.now).toISOString().slice(0, 10);
    const resourceId = await defaultResource(client, tenant.id);

    if (cmd.kind === "show_blocks") {
      const blocks = await listBlocks(client, tenant.id, resourceId, today);
      const ledgerRow = await log({ command: "show_blocks", count: blocks.length });
      const range = (b: { start: string; end: string }) => (b.start === b.end ? formatDate(b.start) : `${formatDate(b.start)} to ${formatDate(b.end)}`);
      const reply = blocks.length === 0 ? "No dates are blocked." : ["Blocked dates:", ...blocks.map((b) => `- ${range(b)}${b.reason ? `: ${b.reason}` : ""}`)].join("\n");
      return { handled: true, reply, ledgerRow };
    }

    if (cmd.kind === "unblock") {
      const touched = await removeBlockedDate(client, tenant.id, resourceId, cmd.date);
      const ledgerRow = await log({ command: "unblock", date: cmd.date, removed: touched > 0 });
      return { handled: true, reply: touched > 0 ? `Unblocked ${formatDate(cmd.date)}.` : `${formatDate(cmd.date)} was not blocked.`, ledgerRow };
    }

    // block
    const range = cmd.start === cmd.end ? formatDate(cmd.start) : `${formatDate(cmd.start)} to ${formatDate(cmd.end)}`;
    if (cmd.end < today) {
      const ledgerRow = await log({ command: "block", start: cmd.start, end: cmd.end, rejected: "in_the_past" });
      return { handled: true, reply: `${range} has already passed, so nothing was blocked.`, ledgerRow };
    }
    const overlap = await client.query(
      `SELECT 1 FROM availability_blocks WHERE tenant_id=$1 AND resource_id=$2 AND start_date <= $4::date AND end_date >= $3::date LIMIT 1`,
      [tenant.id, resourceId, cmd.start, cmd.end],
    );
    if (overlap.rowCount) {
      const ledgerRow = await log({ command: "block", start: cmd.start, end: cmd.end, rejected: "already_blocked" });
      return { handled: true, reply: `${range} overlaps a block that already exists. Say "show blocks" to see them.`, ledgerRow };
    }
    await addBlock(client, { tenantId: tenant.id, resourceId, start: cmd.start, end: cmd.end, reason: cmd.reason, createdBy: member.id });
    const held = await client.query(
      `SELECT 1 FROM holds WHERE tenant_id=$1 AND resource_id=$2 AND status='active' AND expires_at > $5::timestamptz
         AND start_date <= $4::date AND end_date >= $3::date LIMIT 1`,
      [tenant.id, resourceId, cmd.start, cmd.end, input.now],
    );
    const ledgerRow = await log({ command: "block", start: cmd.start, end: cmd.end, reason: cmd.reason });
    const note = held.rowCount ? " Note: a customer currently has a hold on that date; it was not cancelled." : "";
    return { handled: true, reply: `Blocked ${range}${cmd.reason ? ` (${cmd.reason})` : ""}. New enquiries for it will be told it is not available.${note}`, ledgerRow };
  });
}
