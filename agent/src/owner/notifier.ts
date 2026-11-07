import type { Pool } from "pg";
import { describeReason, type EscalationEvent, type Notifier } from "../escalation/index.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { describeAsk, refOf } from "./format.js";
import { pushRecipients } from "./members.js";
import type { OwnerOutbox } from "./types.js";

export const QUICK_REPLIES = "quote ₹__ / decline / call them";

/**
 * The owner side of the escalation seam: a refusal that survives the commit is sent to every owner and manager with
 * its ref (`R<n>`, the refusal's ledger position) and the quick replies. The text is a code template over typed fields.
 */
export function createOwnerNotifier(deps: { pool: Pool; outbox: OwnerOutbox; kernel?: KernelBridge }): Notifier {
  return {
    async notify(e: EscalationEvent) {
      const kernel = deps.kernel ?? (await loadKernel());
      const sent = await withTenant(deps.pool, e.tenantId, async (c) => {
        const ref = (
          await c.query<{ tenant_seq: number }>(
            "SELECT tenant_seq::int AS tenant_seq FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND type='refusal' ORDER BY tenant_seq DESC LIMIT 1",
            [e.tenantId, e.threadId],
          )
        ).rows[0];
        if (!ref) return undefined;
        const name = (await c.query<{ name: string }>("SELECT name FROM tenants WHERE id=$1", [e.tenantId])).rows[0]?.name ?? e.tenantId;
        const to = await pushRecipients(c, e.tenantId);
        const r = refOf(ref.tenant_seq);
        const text = [
          `[${r}] ${name}: a customer enquiry needs you.`,
          `Why: ${describeReason(e.reason)}`,
          `They asked: ${describeAsk(e.fields)}`,
          `Reply: ${QUICK_REPLIES}`,
          `Say "why ${r}" for the details.`,
        ].join("\n");
        await appendEntry(c, kernel, {
          tenantId: e.tenantId, threadId: e.threadId, at: e.at, type: "owner_message",
          payload: { command: "escalation_sent", ref: r, refusalTenantSeq: ref.tenant_seq, to: to.map((m) => m.id) },
        });
        return { to, text };
      });
      if (!sent) return;
      for (const m of sent.to) await deps.outbox.send({ tenantId: e.tenantId, toMemberId: m.id, role: m.role, kind: "escalation", text: sent.text, at: e.at });
    },
  };
}

/** Fan one escalation out to several notifiers (e.g. the log stub and the owner channel). */
export function composeNotifiers(...ns: Notifier[]): Notifier {
  return {
    async notify(e) {
      for (const n of ns) await n.notify(e);
    },
  };
}
