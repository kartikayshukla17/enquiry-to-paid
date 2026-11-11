import type { PoolClient } from "pg";
import type { ExtractedFields, RefusalReason } from "../kernel/types.js";

/** A refused enquiry that the owner can still act on: the thread's latest refusal, thread still `refused`. */
export interface OpenRefusal {
  /** The refusal's position in the tenant's ledger chain: the number in the `R<n>` ref. */
  tenantSeq: number;
  /** ledger_entries.seq of the refusal. */
  seq: number;
  threadId: string;
  reason: RefusalReason;
  ruleGap?: string;
  suggestion?: string;
  fields: Partial<ExtractedFields>;
  /** The owner already said "call them" for this refusal (a follow-up marker); it still can be quoted or declined. */
  calledBack: boolean;
  /** ledger_entries.at for the refusal -- an ISO timestamp, the escalation's "age". */
  at: string;
}

interface Row {
  tenant_seq: number;
  seq: number;
  thread_id: string;
  payload: { reason: RefusalReason; ruleGap?: string; suggestion?: string };
  fields: Partial<ExtractedFields>;
  called: boolean;
  at: Date;
}

/**
 * Derived from the ledger and threads, never stored separately: the latest refusal on each thread whose state is still
 * `refused`. A clarifying question (`missing_required_field`) is not an escalation. A new customer message that is
 * refused again supersedes the old refusal; an owner quote or decline moves the thread out of `refused`.
 */
export async function listOpenRefusals(client: PoolClient, tenantId: string): Promise<OpenRefusal[]> {
  const { rows } = await client.query<Row>(
    `WITH latest AS (
       SELECT DISTINCT ON (l.thread_id) l.thread_id, l.tenant_seq, l.seq, l.payload, l.at
         FROM ledger_entries l
        WHERE l.tenant_id = $1 AND l.type = 'refusal'
        ORDER BY l.thread_id, l.tenant_seq DESC)
     SELECT latest.tenant_seq::int AS tenant_seq, latest.seq::float8 AS seq, latest.thread_id, latest.payload, latest.at, t.fields,
            EXISTS (SELECT 1 FROM ledger_entries a
                     WHERE a.tenant_id = $1 AND a.thread_id = latest.thread_id AND a.tenant_seq > latest.tenant_seq
                       AND a.type = 'owner_message' AND a.payload->>'command' = 'call_them') AS called
       FROM latest JOIN threads t ON t.id = latest.thread_id
      WHERE t.state = 'refused' AND latest.payload->>'reason' <> 'missing_required_field'
      ORDER BY latest.tenant_seq`,
    [tenantId],
  );
  return rows.map((r) => ({
    tenantSeq: r.tenant_seq,
    seq: r.seq,
    threadId: r.thread_id,
    reason: r.payload.reason,
    ...(r.payload.ruleGap !== undefined && { ruleGap: r.payload.ruleGap }),
    ...(r.payload.suggestion !== undefined && { suggestion: r.payload.suggestion }),
    fields: r.fields,
    calledBack: r.called,
    at: r.at.toISOString(),
  }));
}
