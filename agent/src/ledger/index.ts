import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export type LedgerType =
  | "enquiry" | "extraction" | "quote" | "refusal" | "hold" | "owner_message"
  | "payment_link" | "collected" | "chase" | "correction";

export interface LedgerRow {
  seq: number;
  tenantId: string;
  threadId: string;
  at: string;
  type: LedgerType;
  payload: unknown;
  rateCardHash: string | null;
  modelId: string | null;
  provider: string | null;
  region: string | null;
  costMinor: number | null;
  prevHash: string;
  hash: string;
  corrects: number | null;
}

export interface NewEntry {
  tenantId: string;
  threadId: string;
  at: string;
  type: LedgerType;
  payload: unknown;
  rateCardHash?: string;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const GENESIS_HASH = "0".repeat(64);

/** T1 placeholder: sha256 of canonical payload, no chain. T4 replaces this with the kernel's hash chain. */
export function placeholderHash(e: NewEntry): string {
  return createHash("sha256").update(canonicalJson({ type: e.type, payload: e.payload })).digest("hex");
}

export async function appendEntry(client: PoolClient, e: NewEntry): Promise<LedgerRow> {
  const { rows } = await client.query(
    `INSERT INTO ledger_entries (tenant_id, thread_id, at, type, payload, rate_card_hash, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING seq::int AS seq, tenant_id, thread_id, at, type, payload, rate_card_hash,
               model_id, provider, region, cost_minor::int AS cost_minor, prev_hash, hash, corrects::int AS corrects`,
    [e.tenantId, e.threadId, e.at, e.type, JSON.stringify(e.payload), e.rateCardHash ?? null, GENESIS_HASH, placeholderHash(e)],
  );
  const r = rows[0];
  return {
    seq: r.seq,
    tenantId: r.tenant_id,
    threadId: r.thread_id,
    at: (r.at as Date).toISOString(),
    type: r.type,
    payload: r.payload,
    rateCardHash: r.rate_card_hash,
    modelId: r.model_id,
    provider: r.provider,
    region: r.region,
    costMinor: r.cost_minor,
    prevHash: r.prev_hash,
    hash: r.hash,
    corrects: r.corrects,
  };
}
