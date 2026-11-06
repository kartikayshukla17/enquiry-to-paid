import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createLogNotifier, type Notifier } from "../escalation/index.js";
import { loadKernel } from "../kernel/index.js";
import type { LedgerRow } from "../ledger/index.js";
import { createProvider } from "../llm/config.js";
import type { LlmProvider } from "../llm/types.js";
import { handleMessage } from "../pipeline/handle-message.js";
import { REPO_ROOT } from "./run-fixture.js";

export interface ChatOptions {
  pool: Pool;
  tenantId?: string;
  /** Rate card path relative to the repo root. */
  card?: string;
  /** Same customer + thread across invocations = a continuing conversation. */
  customerRef?: string;
  llm?: LlmProvider;
  wordReplies?: boolean;
  notifier?: Notifier;
  now?: string;
}

/** The seam behind `pnpm sim chat "<text>"`: one free-text customer message through the whole pipeline. */
export async function runChat(text: string, opts: ChatOptions): Promise<{ reply: string; ledgerRow: LedgerRow }> {
  const tenantId = opts.tenantId ?? "tenant-rose-court";
  const customerRef = opts.customerRef ?? "sim-chat-customer";
  const card = opts.card ?? "rate-cards/fictional-banquet.json";
  const rateCard: unknown = JSON.parse(await readFile(path.join(REPO_ROOT, card), "utf8"));
  const res = await handleMessage(
    {
      pool: opts.pool,
      kernel: await loadKernel(),
      notifier: opts.notifier ?? createLogNotifier(),
      llm: opts.llm ?? createProvider(),
      wordReplies: opts.wordReplies ?? process.env.LLM_WORD_REPLIES === "1",
    },
    {
      tenant: { id: tenantId, name: `FICTIONAL: ${tenantId}` },
      threadId: `${tenantId}:thread:chat:${customerRef}`,
      customerRef,
      rateCard,
      rateCardVersion: (rateCard as { version: number }).version,
      now: opts.now ?? "2026-11-07T10:00:00Z",
      availability: { blockedDates: [] },
      message: text,
    },
  );
  return { reply: res.reply, ledgerRow: res.ledgerRow };
}
