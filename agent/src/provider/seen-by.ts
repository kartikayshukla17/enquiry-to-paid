import type { Pool } from "pg";

export interface SeenBy {
  provider: string;
  modelId: string;
  region: string;
  /** Distinct enquiry rows (customer messages) this provider/region received. */
  messages: number;
}

/**
 * The `customer_text_seen_by` record: for every distinct provider/model/region, how many customer messages it processed.
 * Derived from the enquiry ledger rows, which are written for every message before anything else, so a provider
 * that saw customer text cannot be missing from this list. Optionally scoped to one tenant.
 */
export async function customerTextSeenBy(pool: Pool, tenantId?: string): Promise<SeenBy[]> {
  const { rows } = await pool.query(
    `SELECT provider, model_id, region, count(*)::int AS messages FROM ledger_entries
     WHERE type = 'enquiry' AND ($1::text IS NULL OR tenant_id = $1)
     GROUP BY provider, model_id, region ORDER BY provider, model_id, region`,
    [tenantId ?? null],
  );
  return rows.map((r) => ({ provider: r.provider, modelId: r.model_id, region: r.region, messages: r.messages }));
}
