import type { Pool } from "pg";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { piiKeysFromEnv, type PiiKeys } from "../security/pii.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { digestInTxn } from "./digest.js";
import { handleOwnerMessage, type OwnerMessageInput, type OwnerMessageResult } from "./handle.js";
import { findMemberByPhone, pushRecipients } from "./members.js";
import type { OwnerOutbox } from "./types.js";

/**
 * The front door for every inbound WhatsApp message. A sender whose phone hash matches a member of the tenant (any role) is on
 * the owner channel and is NEVER passed to the customer pipeline, whatever the text says. Anyone else is a customer; the
 * text "quote 5000" from a stranger is just a customer message and cannot set a price.
 */
export async function routeInbound<C>(
  deps: { pool: Pool; kernel?: KernelBridge; pii?: PiiKeys },
  input: OwnerMessageInput,
  asCustomer: () => Promise<C>,
): Promise<{ channel: "owner"; result: OwnerMessageResult } | { channel: "customer"; result: C }> {
  const pii = deps.pii ?? piiKeysFromEnv();
  const member = await withTenant(deps.pool, input.tenant.id, (c) => findMemberByPhone(c, input.tenant.id, pii, input.senderRef));
  if (member) return { channel: "owner", result: await handleOwnerMessage({ ...deps, pii }, input) };
  return { channel: "customer", result: await asCustomer() };
}

/** The daily push: the digest for the 24 hours up to `now`, sent to every owner and manager, and recorded on the ledger. */
export async function sendDailyDigest(
  deps: { pool: Pool; outbox: OwnerOutbox; kernel?: KernelBridge },
  input: { tenant: { id: string; name: string }; now: string },
): Promise<{ text: string; sentTo: string[] }> {
  const kernel = deps.kernel ?? (await loadKernel());
  const { tenant, now } = input;
  const { text, to } = await withTenant(deps.pool, tenant.id, async (c) => {
    const d = await digestInTxn(c, tenant, now);
    const recipients = await pushRecipients(c, tenant.id);
    const thread = `${tenant.id}:thread:ops`;
    if ((await c.query("SELECT 1 FROM threads WHERE id=$1", [thread])).rowCount) {
      await appendEntry(c, kernel, { tenantId: tenant.id, threadId: thread, at: now, type: "owner_message", payload: { command: "digest_sent", counts: d.counts, to: recipients.map((m) => m.id) } });
    }
    return { text: d.text, to: recipients };
  });
  for (const m of to) await deps.outbox.send({ tenantId: tenant.id, toMemberId: m.id, role: m.role, kind: "digest", text, at: now });
  return { text, sentTo: to.map((m) => m.id) };
}
