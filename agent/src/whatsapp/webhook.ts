/**
 * The orchestrating seam behind `POST /webhooks/whatsapp` (V2), same shape as `payments/webhook.ts`'s
 * `handleWebhook`. Order matters (the ticket's literal "Done when"):
 *   1. verify the signature FIRST -- on failure, rejected, and nothing else runs: no parsing, no pipeline,
 *      no send.
 *   2. parse the body (seam 3); `{ kind: "none" }` (a status/delivery-receipt payload, a non-text message,
 *      or malformed JSON) is just acknowledged, nothing further happens.
 *   3. a real inbound text message runs through the SAME pipeline `/chat` already exercises (`runChat`,
 *      which wraps `handleMessage`) with a fixed default tenant/card -- there is exactly one real sandbox
 *      number, so no per-message business selection exists or is needed. `customerRef` is derived from the
 *      sender's phone number, hashed the same way every other customer ref this repo stores is (never the
 *      raw number -- see `customerRefFromPhone` below for why that matters beyond the usual phone_hash/
 *      phone_enc columns).
 *   4. the reply (if any) is handed to an INJECTED send function (seam 5) -- this function never touches the
 *      network itself, which is what makes it testable. A thread paused for the owner (`held`) or a reply
 *      with nothing new to say (an already-settled consent answer) sends nothing, matching `EnquiryResult`'s
 *      own "nothing may be sent" rule.
 */
import type { Pool } from "pg";
import type { LlmProvider } from "../llm/types.js";
import type { ProviderRegistry } from "../payments/registry.js";
import { phoneHash, piiKeysFromEnv } from "../security/pii.js";
import { runChat } from "../simulator/chat.js";
import { parseWhatsAppInbound } from "./inbound.js";
import { verifyWhatsAppSignature } from "./signature.js";

export interface WhatsAppWebhookDeps {
  pool: Pool;
  appSecret: string;
  /** Injected Cloud API send (seam 5, e.g. a closure over `sendWhatsAppText` + its own config). Never called
   *  directly by this module for anything other than handing it the pipeline's reply text. */
  send: (to: string, body: string) => Promise<unknown>;
  paymentProviders?: ProviderRegistry;
  paymentProvider?: string;
  /**
   * Test-only override of `runChat`'s own fixed default tenant/card. The live HTTP route (`server/app.ts`)
   * never sets these -- "all four fictional cards round-trip correctly from at least one sandbox number" is
   * proven by driving THIS seam directly, parameterized across the four `rate-cards/fictional-*.json` cards,
   * not by a real phone number picking a business by name (there is only one real sandbox number).
   */
  tenantId?: string;
  card?: string;
  /** Test-only override of `runChat`'s own LLM provider (same DI seam `pipeline/handle-message.test.ts`
   *  already uses). The live HTTP route never sets this -- it takes `runChat`'s own real-provider default. */
  llm?: LlmProvider;
}

export type WhatsAppWebhookResult =
  | { status: "rejected"; reason: "bad_signature" }
  /** No real inbound text message in the payload at all (seam 3's `{ kind: "none" }`). */
  | { status: "ignored" }
  /** The thread is paused for the owner; the customer's message was stored, nothing was sent. */
  | { status: "held"; threadId: string | null }
  /** Processed, but the pipeline had nothing new to say (e.g. a repeat of an already-settled consent answer); nothing was sent. */
  | { status: "acknowledged"; threadId: string | null }
  /** Processed and `deps.send` was called with the reply. */
  | { status: "replied"; threadId: string | null };

/**
 * Never the raw number: hashed the same way every other customer ref this repo stores is (`security/pii.ts`'s
 * `phoneHash`), BEFORE it is ever passed into the pipeline. This matters beyond the usual `phone_hash`/
 * `phone_enc` columns `handle-enquiry.ts` writes -- that same file also builds `customers.id` directly as
 * `` `${tenantId}:cust:${customerRef}` ``, UNMASKED, from whatever `customerRef` it is given. Passing a raw
 * WhatsApp phone number straight through would land it unmasked in that id column; hashing it here first
 * means it never does.
 */
export function customerRefFromPhone(from: string): string {
  return `wa-${phoneHash(piiKeysFromEnv(), from).slice(0, 32)}`;
}

export async function handleWhatsAppWebhook(
  deps: WhatsAppWebhookDeps,
  rawBody: string,
  headers: Record<string, string | undefined>,
  now: string,
): Promise<WhatsAppWebhookResult> {
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  if (!verifyWhatsAppSignature(deps.appSecret, rawBody, lower["x-hub-signature-256"])) {
    return { status: "rejected", reason: "bad_signature" };
  }

  const inbound = parseWhatsAppInbound(rawBody);
  if (inbound.kind === "none") return { status: "ignored" };

  const customerRef = customerRefFromPhone(inbound.from);
  const res = await runChat(inbound.text, {
    pool: deps.pool,
    customerRef,
    now,
    ...(deps.tenantId !== undefined && { tenantId: deps.tenantId }),
    ...(deps.card !== undefined && { card: deps.card }),
    ...(deps.llm !== undefined && { llm: deps.llm }),
    ...(deps.paymentProviders && deps.paymentProvider !== undefined && { paymentProviders: deps.paymentProviders, paymentProvider: deps.paymentProvider }),
  });
  const threadId = res.ledgerRow.threadId;

  if (res.held) return { status: "held", threadId };
  if (!res.reply) return { status: "acknowledged", threadId };
  await deps.send(inbound.from, res.reply);
  return { status: "replied", threadId };
}
