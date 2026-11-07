/**
 * The timer worker's chaser branch (T19). Everything is decided here, under the thread lock, at send time: a cancellation that
 * happened (or a customer who wrote) after the timer was scheduled is seen now, so scheduling-time checks are never the only guard.
 */
import type { PoolClient } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { cancelChaser, consentOf } from "./consent.js";
import type { ChaserOutbox } from "./types.js";

export type ChaserRun = { sent?: 1 | 2; retryAt?: string };

export async function runChaserInTxn(
  c: PoolClient,
  kernel: KernelBridge,
  _outbox: ChaserOutbox,
  a: { tenantId: string; threadId: string; now: string },
): Promise<ChaserRun> {
  const th = (await c.query<{ state: string; customer_id: string }>("SELECT state, customer_id FROM threads WHERE id=$1 FOR UPDATE", [a.threadId])).rows[0];
  if (!th) return {};
  const quote = (
    await c.query<{ tenant_seq: number }>("SELECT tenant_seq::int AS tenant_seq FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 AND type='quote' ORDER BY tenant_seq DESC LIMIT 1", [a.tenantId, a.threadId])
  ).rows[0];
  const cs = await consentOf(c, a.tenantId, th.customer_id);
  if (cs.status !== "granted") {
    await cancelChaser(c, kernel, { tenantId: a.tenantId, threadId: a.threadId, reason: cs.status === "revoked" ? "consent_revoked" : "no_consent", at: a.now, ...(quote && { quoteSeq: quote.tenant_seq }) });
  }
  return {};
}
