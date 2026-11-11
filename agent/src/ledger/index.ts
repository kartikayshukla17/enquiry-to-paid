import type { Pool, PoolClient } from "pg";
import type { KernelBridge } from "../kernel/index.js";

export type LedgerType =
  | "enquiry" | "extraction" | "quote" | "refusal" | "hold" | "owner_message"
  | "payment_link" | "collected" | "chase" | "correction" | "disclosure"
  | "rate_card_approved" | "rate_card_rejected" | "kill_switch_changed" | "payment_mismatch"
  | "owner_quote" | "consent" | "stop" | "chaser_sent" | "payment_held_for_review"
  | "payment_failed" | "payment_refunded";

export interface LedgerRow {
  /** Global row id (primary key); what `corrects` points at. */
  seq: number;
  tenantId: string;
  /** Position in this tenant's hash chain, starting at 1. */
  tenantSeq: number;
  threadId: string | null;
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
  threadId: string | null;
  at: string;
  type: Exclude<LedgerType, "correction">;
  payload: unknown;
  rateCardHash?: string;
  modelId?: string;
  provider?: string;
  region?: string;
  costMinor?: number;
}

export const GENESIS_HASH = "0".repeat(64);

const COLUMNS = `seq::int AS seq, tenant_id, tenant_seq::int AS tenant_seq, thread_id, at, type, payload,
  rate_card_hash, model_id, provider, region, cost_minor::int AS cost_minor, prev_hash, hash, corrects::int AS corrects`;

interface DbRow {
  seq: number; tenant_id: string; tenant_seq: number; thread_id: string | null; at: Date; type: LedgerType;
  payload: unknown; rate_card_hash: string | null; model_id: string | null; provider: string | null;
  region: string | null; cost_minor: number | null; prev_hash: string; hash: string; corrects: number | null;
}

const toRow = (r: DbRow): LedgerRow => ({
  seq: r.seq,
  tenantId: r.tenant_id,
  tenantSeq: r.tenant_seq,
  threadId: r.thread_id,
  at: r.at.toISOString(),
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
});

/** The hashed view of a row: what the kernel's chain_hash/verify_chain consume. */
const hashable = (r: LedgerRow) => ({
  tenantId: r.tenantId,
  tenantSeq: r.tenantSeq,
  threadId: r.threadId,
  at: r.at,
  type: r.type,
  payload: r.payload,
  rateCardHash: r.rateCardHash,
  modelId: r.modelId,
  provider: r.provider,
  region: r.region,
  costMinor: r.costMinor,
  corrects: r.corrects,
  prevHash: r.prevHash,
  hash: r.hash,
});

async function insertChained(
  client: PoolClient,
  kernel: KernelBridge,
  e: NewEntry | (Omit<NewEntry, "type"> & { type: "correction" }),
  corrects: number | null,
): Promise<LedgerRow> {
  // Per-tenant head row: the FOR UPDATE lock serialises appends to one tenant's chain
  // for the rest of the caller's transaction, so prev_hash/tenant_seq can never fork.
  await client.query(
    `INSERT INTO ledger_heads (tenant_id, last_tenant_seq, last_hash) VALUES ($1, 0, $2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [e.tenantId, GENESIS_HASH],
  );
  const head = (
    await client.query<{ last_tenant_seq: number; last_hash: string }>(
      "SELECT last_tenant_seq::int AS last_tenant_seq, last_hash FROM ledger_heads WHERE tenant_id=$1 FOR UPDATE",
      [e.tenantId],
    )
  ).rows[0];
  if (!head) throw new Error("ledger head missing");
  const at = new Date(e.at).toISOString();
  const content = {
    tenantId: e.tenantId,
    tenantSeq: head.last_tenant_seq + 1,
    threadId: e.threadId,
    at,
    type: e.type,
    payload: e.payload,
    rateCardHash: e.rateCardHash ?? null,
    modelId: e.modelId ?? null,
    provider: e.provider ?? null,
    region: e.region ?? null,
    costMinor: e.costMinor ?? null,
    corrects,
    prevHash: head.last_hash,
  };
  const hash = kernel.chainHash(content);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`kernel chain_hash failed: ${hash}`);
  const { rows } = await client.query<DbRow>(
    `INSERT INTO ledger_entries (tenant_id, tenant_seq, thread_id, at, type, payload, rate_card_hash,
                                 model_id, provider, region, cost_minor, corrects, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${COLUMNS}`,
    [
      content.tenantId, content.tenantSeq, content.threadId, at, content.type, JSON.stringify(content.payload),
      content.rateCardHash, content.modelId, content.provider, content.region, content.costMinor,
      content.corrects, content.prevHash, hash,
    ],
  );
  await client.query("UPDATE ledger_heads SET last_tenant_seq=$2, last_hash=$3 WHERE tenant_id=$1", [
    e.tenantId, content.tenantSeq, hash,
  ]);
  const row = rows[0];
  if (!row) throw new Error("ledger insert returned no row");
  return toRow(row);
}

/** Appends one chained entry. Call inside the caller's transaction (it takes the tenant's head lock). */
export function appendEntry(client: PoolClient, kernel: KernelBridge, e: NewEntry): Promise<LedgerRow> {
  return insertChained(client, kernel, e, null);
}

/** Never edits: writes a new "correction" row whose `corrects` is the original's seq. */
export async function appendCorrection(
  client: PoolClient,
  kernel: KernelBridge,
  entryRef: { seq: number },
  payload: unknown,
  at: string,
): Promise<LedgerRow> {
  const { rows } = await client.query<{ tenant_id: string; thread_id: string | null }>(
    "SELECT tenant_id, thread_id FROM ledger_entries WHERE seq=$1",
    [entryRef.seq],
  );
  const target = rows[0];
  if (!target) throw new Error(`ledger entry ${entryRef.seq} not found`);
  return insertChained(
    client,
    kernel,
    { tenantId: target.tenant_id, threadId: target.thread_id, at, type: "correction", payload },
    entryRef.seq,
  );
}

export type LedgerReason = "seq_gap" | "prev_hash_mismatch" | "hash_mismatch" | "tail_truncated";

export type LedgerVerdict =
  | { ok: true; tenants: { tenantId: string; count: number }[] }
  | { ok: false; tenantId: string; seq: number | null; tenantSeq: number | null; reason: LedgerReason };

/** Walks the chain of one tenant (or all) from the DB; the first broken row wins. */
export async function verifyLedger(
  pool: Pool,
  kernel: KernelBridge,
  opts: { tenantId?: string } = {},
): Promise<LedgerVerdict> {
  const tenantIds = opts.tenantId
    ? [opts.tenantId]
    : (
        await pool.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM ledger_entries UNION SELECT tenant_id FROM ledger_heads ORDER BY 1`,
        )
      ).rows.map((r) => r.tenant_id);
  const tenants: { tenantId: string; count: number }[] = [];
  for (const tenantId of tenantIds) {
    const { rows } = await pool.query<DbRow>(
      `SELECT ${COLUMNS} FROM ledger_entries WHERE tenant_id=$1 ORDER BY tenant_seq`,
      [tenantId],
    );
    const entries = rows.map(toRow);
    const verdict = kernel.verifyChain(entries.map(hashable));
    if (!verdict.ok) {
      const bad = entries.find((r) => r.tenantSeq === verdict.brokenSeq);
      return { ok: false, tenantId, seq: bad?.seq ?? null, tenantSeq: verdict.brokenSeq, reason: verdict.reason };
    }
    const head = (
      await pool.query<{ last_tenant_seq: number; last_hash: string }>(
        "SELECT last_tenant_seq::int AS last_tenant_seq, last_hash FROM ledger_heads WHERE tenant_id=$1",
        [tenantId],
      )
    ).rows[0];
    const last = entries[entries.length - 1];
    if (head && (head.last_tenant_seq !== (last?.tenantSeq ?? 0) || head.last_hash !== (last?.hash ?? "0".repeat(64)))) {
      return {
        ok: false,
        tenantId,
        seq: null,
        tenantSeq: (last?.tenantSeq ?? 0) + 1,
        reason: "tail_truncated",
      };
    }
    tenants.push({ tenantId, count: verdict.count });
  }
  return { ok: true, tenants };
}
