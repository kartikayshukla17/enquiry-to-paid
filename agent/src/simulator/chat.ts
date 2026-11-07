import type { Pool } from "pg";
import { createLogNotifier, type Notifier } from "../escalation/index.js";
import { loadKernel } from "../kernel/index.js";
import type { LedgerRow } from "../ledger/index.js";
import { createProvider } from "../llm/config.js";
import type { LlmProvider } from "../llm/types.js";
import { collectingOutbox, type OwnerOutbox, type OwnerOutgoing } from "../owner/types.js";
import { handleMessage } from "../pipeline/handle-message.js";
import { seedApprovedCard } from "../ratecard/legacy.js";
import { loadCardSource } from "../ratecard/source.js";

export interface ChatOptions {
  pool: Pool;
  tenantId?: string;
  /** Rate card path relative to the repo root. */
  card?: string;
  /** Same customer + thread across invocations = a continuing conversation. */
  customerRef?: string;
  llm?: LlmProvider;
  wordReplies?: boolean;
  /** Where held customer messages are shown to the owner; defaults to a collecting stub (the chat has no owner screen). */
  ownerOutbox?: OwnerOutbox;
  notifier?: Notifier;
  now?: string;
}

/** The seam behind `pnpm sim chat "<text>"`: one free-text customer message through the whole pipeline. */
export async function runChat(text: string, opts: ChatOptions): Promise<{ reply: string; ledgerRow: LedgerRow; held?: true }> {
  const tenantId = opts.tenantId ?? "tenant-rose-court";
  const customerRef = opts.customerRef ?? "sim-chat-customer";
  const card = opts.card ?? "rate-cards/fictional-banquet.json";
  const kernel = await loadKernel();
  const rateCard = await loadCardSource(card, kernel);
  const now = opts.now ?? "2026-11-07T10:00:00Z";
  // Demo setup: the card goes through the real approval gate (read-backs answered yes by a seeded owner) first.
  await seedApprovedCard({ pool: opts.pool, kernel }, { tenant: { id: tenantId, name: `FICTIONAL: ${tenantId}` }, card: rateCard, now });
  const sink: OwnerOutgoing[] = [];
  const res = await handleMessage(
    {
      pool: opts.pool,
      kernel,
      notifier: opts.notifier ?? createLogNotifier(),
      ownerOutbox: opts.ownerOutbox ?? collectingOutbox(sink),
      llm: opts.llm ?? createProvider(),
      wordReplies: opts.wordReplies ?? process.env.LLM_WORD_REPLIES === "1",
    },
    {
      tenant: { id: tenantId, name: `FICTIONAL: ${tenantId}` },
      threadId: `${tenantId}:thread:chat:${customerRef}`,
      customerRef,
      rateCard,
      now,
      availability: { blockedDates: [] },
      message: text,
    },
  );
  return { reply: res.reply, ledgerRow: res.ledgerRow, ...(res.held && { held: true as const }) };
}
