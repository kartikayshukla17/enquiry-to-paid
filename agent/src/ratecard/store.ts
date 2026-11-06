/**
 * Versioned rate-card storage and the activation gate.
 *
 * Revisions are immutable snapshots (`compiled` + `content_hash`, hash computed by the kernel). A compile
 * produces a 'draft'; only an approval (approve.ts) makes a revision 'approved'. `loadActiveCard` is the only
 * way the pipeline obtains a card: it returns the approved snapshot, re-hashes it, and refuses on any mismatch.
 */
import type { Pool, PoolClient } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { withTenant } from "../tenancy/with-tenant.js";

export type CardStatus = "draft" | "approved" | "superseded";

export interface CardRevision {
  id: string;
  tenantId: string;
  cardId: string;
  /** Storage revision: 1, 2, 3 ... per tenant+card (not the card's own `version` field, which is part of the hash). */
  version: number;
  contentHash: string;
  status: CardStatus;
  compiled: Record<string, unknown>;
  approvedAt: string | null;
  approvedBy: string | null;
  approvedHash: string | null;
  source: string | null;
  rejectionReason: string | null;
}

interface Db {
  id: string; tenant_id: string; card_id: string; version: number; content_hash: string; status: CardStatus;
  compiled: Record<string, unknown>; approved_at: Date | null; approved_by: string | null; approved_hash: string | null;
  source: string | null; rejection_reason: string | null;
}

export const REVISION_COLUMNS = `id, tenant_id, card_id, version, content_hash, status, compiled, approved_at, approved_by,
  approved_hash, source, rejection_reason`;

export const toRevision = (r: Db): CardRevision => ({
  id: r.id, tenantId: r.tenant_id, cardId: r.card_id, version: r.version, contentHash: r.content_hash, status: r.status,
  compiled: r.compiled, approvedAt: r.approved_at ? r.approved_at.toISOString() : null, approvedBy: r.approved_by,
  approvedHash: r.approved_hash, source: r.source, rejectionReason: r.rejection_reason,
});

export interface Deps {
  pool: Pool;
  kernel: KernelBridge;
}

export class CardError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * Stores a compiled card as a new draft revision. The kernel must call it well-formed. Compiling the same content
 * again returns the existing revision (same hash, same status) instead of piling up duplicates.
 */
export async function publishDraft(
  deps: Deps,
  input: { tenant: { id: string; name: string }; card: Record<string, unknown>; source?: string },
): Promise<CardRevision> {
  const verdict = deps.kernel.validateCard(input.card);
  if (!verdict.ok) throw new CardError("invalid_card", "path" in verdict ? `${verdict.path}: ${verdict.message}` : verdict.error);
  const hash = deps.kernel.rateCardHash(input.card);
  const cardId = input.card.id;
  if (typeof cardId !== "string" || cardId === "") throw new CardError("invalid_card", "id");
  return withTenant(deps.pool, input.tenant.id, async (client) => {
    await client.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [input.tenant.id, input.tenant.name]);
    // Serialise concurrent publishes of one card so the revision counter cannot fork.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${input.tenant.id}:${cardId}`]);
    const same = (
      await client.query<Db>(`SELECT ${REVISION_COLUMNS} FROM rate_cards WHERE tenant_id=$1 AND card_id=$2 AND content_hash=$3 ORDER BY version DESC LIMIT 1`, [input.tenant.id, cardId, hash])
    ).rows[0];
    if (same) return toRevision(same);
    const next = (await client.query<{ n: number }>("SELECT COALESCE(MAX(version),0)::int + 1 AS n FROM rate_cards WHERE tenant_id=$1 AND card_id=$2", [input.tenant.id, cardId])).rows[0]?.n ?? 1;
    const { rows } = await client.query<Db>(
      `INSERT INTO rate_cards (id, tenant_id, card_id, version, content_hash, compiled, source, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft') RETURNING ${REVISION_COLUMNS}`,
      [`${input.tenant.id}:${cardId}:${next}`, input.tenant.id, cardId, next, hash, JSON.stringify(input.card), input.source ?? null],
    );
    return toRevision(rows[0] as Db);
  });
}

export async function getRevision(client: PoolClient, tenantId: string, cardId: string, version: number): Promise<CardRevision | undefined> {
  const r = (await client.query<Db>(`SELECT ${REVISION_COLUMNS} FROM rate_cards WHERE tenant_id=$1 AND card_id=$2 AND version=$3`, [tenantId, cardId, version])).rows[0];
  return r ? toRevision(r) : undefined;
}

/** Newest revision of a card (what the owner just compiled), or undefined. */
export async function latestRevision(client: PoolClient, tenantId: string, cardId: string): Promise<CardRevision | undefined> {
  const r = (await client.query<Db>(`SELECT ${REVISION_COLUMNS} FROM rate_cards WHERE tenant_id=$1 AND card_id=$2 ORDER BY version DESC LIMIT 1`, [tenantId, cardId])).rows[0];
  return r ? toRevision(r) : undefined;
}

/** Why the pipeline will not quote. A closed set: it becomes the refusal's `ruleGap`. */
export type GateGap = "card_not_approved" | "card_hash_mismatch";

export type ActiveCard =
  | { ok: true; card: Record<string, unknown>; hash: string; revision: CardRevision }
  | { ok: false; gap: GateGap };

/**
 * The activation gate. Returns the tenant's approved snapshot of `cardId` iff it exists AND its stored content still
 * hashes (kernel) to both `content_hash` and the hash pinned at approval. Newer drafts are invisible here: editing a
 * source after approval changes nothing until the new revision is approved.
 */
export async function loadActiveCard(client: PoolClient, kernel: KernelBridge, tenantId: string, cardId: string): Promise<ActiveCard> {
  const row = (
    await client.query<Db>(`SELECT ${REVISION_COLUMNS} FROM rate_cards WHERE tenant_id=$1 AND card_id=$2 AND status='approved'`, [tenantId, cardId])
  ).rows[0];
  if (!row || row.approved_at === null || row.approved_by === null || row.approved_hash === null) return { ok: false, gap: "card_not_approved" };
  const actual = kernel.rateCardHash(row.compiled);
  if (actual !== row.approved_hash || actual !== row.content_hash) return { ok: false, gap: "card_hash_mismatch" };
  return { ok: true, card: row.compiled, hash: actual, revision: toRevision(row) };
}
