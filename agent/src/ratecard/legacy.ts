/**
 * Test / demo / eval setup helper: puts an already-written card through the SAME gate production uses
 * (publish a draft, generate the kernel-priced read-backs, answer yes as a seeded owner, approve). It exists so fixtures,
 * the eval harness and the adversarial suite can price from hand-written JSON cards without any bypass in the pipeline:
 * the pipeline itself only ever quotes from an approved snapshot. Never call this from production code paths.
 */
import { withTenant } from "../tenancy/with-tenant.js";
import { startApproval, submitApproval, type Answer } from "./approve.js";
import { CardError, publishDraft, type CardRevision, type Deps } from "./store.js";

/** Member ids are global primary keys, so the seeded owner is per tenant. */
export const legacyOwner = (tenantId: string) => `${tenantId}:legacy-seed-owner`;

/** Idempotent: a card already active with the same content is left alone. */
export async function seedApprovedCard(
  deps: Deps,
  input: { tenant: { id: string; name: string }; card: unknown; now: string; source?: string },
): Promise<CardRevision> {
  const rev = await publishDraft(deps, { tenant: input.tenant, card: input.card as Record<string, unknown>, source: input.source ?? "legacy-seed" });
  if (rev.status === "approved") return rev;
  await withTenant(deps.pool, input.tenant.id, (c) =>
    c.query("INSERT INTO members (id, tenant_id, role) VALUES ($1,$2,'owner') ON CONFLICT (id) DO NOTHING", [legacyOwner(input.tenant.id), input.tenant.id]),
  );
  try {
    const { readbacks } = await startApproval(deps, { tenantId: input.tenant.id, cardId: rev.cardId, version: rev.version, now: input.now });
    const answers: Record<string, Answer> = Object.fromEntries(readbacks.map((r) => [r.id, "yes" as const]));
    const res = await submitApproval(deps, { tenantId: input.tenant.id, cardId: rev.cardId, version: rev.version, memberId: legacyOwner(input.tenant.id), answers, now: input.now });
    if (!res.approved) throw new Error("legacy seed approval was refused");
    return res.revision;
  } catch (e) {
    // Concurrent test setup: another caller approved this very revision first. That is the state we wanted.
    if (e instanceof CardError && e.code === "already_approved") return publishDraft(deps, { tenant: input.tenant, card: input.card as Record<string, unknown> });
    throw e;
  }
}
