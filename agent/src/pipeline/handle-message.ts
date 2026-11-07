import type { Pool } from "pg";
import { extractFields } from "../extract/extract.js";
import type { AvailabilityProvider } from "../availability/types.js";
import type { KernelBridge } from "../kernel/index.js";
import type { Notifier } from "../escalation/index.js";
import type { LlmProvider } from "../llm/types.js";
import { makeReplyWorder } from "../llm/word-reply.js";
import type { OwnerOutbox } from "../owner/types.js";
import type { PiiKeys } from "../security/pii.js";
import type { PaymentProvider } from "../payments/types.js";
import type { ProviderRegistry } from "../payments/registry.js";
import { readKillSwitch } from "../killswitch/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { handleConsentMessage } from "../chasers/consent.js";
import { PauseRaced, handleEnquiry, type EnquiryInput, type EnquiryResult, type Provenance } from "./handle-enquiry.js";

export interface MessageDeps {
  pool: Pool;
  kernel: KernelBridge;
  notifier: Notifier;
  llm: LlmProvider;
  pii?: PiiKeys;
  /** Let the model reword quote and clarifying replies (numbers still injected and checked by code). */
  wordReplies?: boolean;
  lowConfidenceBps?: number;
  /** Where dates are checked and held (native Postgres in production). Absent: only the static `availability` input applies. */
  availability?: AvailabilityProvider;
  /** Payment provider (simulated in v0): when set, a quote reply carries a code-written payment link. */
  payments?: PaymentProvider;
  /** Per-tenant provider selection (T16): takes precedence over `payments` when set. */
  paymentProviders?: ProviderRegistry;
  /** Where a customer message on a thread paused for the owner is shown to them (T18). */
  ownerOutbox?: OwnerOutbox;
  /** Chasers (T19): quotes ask for opt-in and schedule reminders. Off by default, so existing replies are unchanged. */
  chasers?: true;
}

const UNKNOWN: Omit<Provenance, "costMinor"> = { modelId: "unknown", provider: "unknown", region: "unknown" };

/**
 * Free text in, outcome out: text -> LlmProvider.extract -> strict schema validation -> confidence gate ->
 * kernel. Provider failure or schema-invalid output never reaches the kernel: it yields the safe holding
 * reply, a refusal ledger row with the reason, and an escalation.
 */
export async function handleMessage(
  deps: MessageDeps,
  e: Omit<EnquiryInput, "fields" | "provenance" | "extractionFailure" | "pausedSeen">,
): Promise<EnquiryResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await handleOnce(deps, e);
    } catch (err) {
      // The thread was handed back between the pause check and the lock: look again.
      if (!(err instanceof PauseRaced) || attempt >= 2) throw err;
    }
  }
}

async function handleOnce(deps: MessageDeps, e: Omit<EnquiryInput, "fields" | "provenance" | "extractionFailure" | "pausedSeen">): Promise<EnquiryResult> {
  // A consent answer ("yes" to the opt-in question, a stop word) is settled by code before anything else: no model sees it.
  const consent = await handleConsentMessage(deps, e);
  if (consent) return consent;
  // A thread paused for the owner (T18) comes first: the text is stored and shown to the owner, no LLM sees it, nothing is sent back.
  const paused = await withTenant(deps.pool, e.tenant.id, async (c) => (await c.query("SELECT 1 FROM threads WHERE id=$1 AND state='paused_owner'", [e.threadId])).rowCount === 1);
  // The very first thing: if the kill switch is on, the customer text goes nowhere (no extraction, no LLM call).
  const ks = await withTenant(deps.pool, e.tenant.id, (c) => readKillSwitch(c, e.tenant.id)); // a failed read throws: fail closed, never fail open
  const inner = {
    pool: deps.pool,
    kernel: deps.kernel,
    notifier: deps.notifier,
    ...(deps.pii && { pii: deps.pii }),
    ...(deps.ownerOutbox && { ownerOutbox: deps.ownerOutbox }),
    ...(deps.chasers && { chasers: deps.chasers }),
    ...(deps.availability && { availability: deps.availability }),
    ...(deps.payments && { payments: deps.payments }),
    ...(deps.paymentProviders && { paymentProviders: deps.paymentProviders }),
    ...(deps.lowConfidenceBps !== undefined && { lowConfidenceBps: deps.lowConfidenceBps }),
    ...(deps.wordReplies && { worder: makeReplyWorder(deps.llm) }),
  };
  if (paused) return handleEnquiry(inner, { ...e, fields: {}, pausedSeen: true });
  if (ks.on) {
    return handleEnquiry(inner, { ...e, fields: {}, killSwitchSeen: { scope: ks.scope } });
  }
  const ext = await extractFields(deps.llm, e.message);
  if (ext.ok) {
    const m = ext.meta;
    const provenance = { modelId: m.modelId, provider: m.provider, region: m.region, costMinor: m.usage.costMinor ?? 0 };
    return handleEnquiry(inner, { ...e, fields: { ...ext.fields }, provenance });
  }
  const m = ext.meta ?? ext.attempt;
  const provenance: Provenance = {
    modelId: m?.modelId ?? UNKNOWN.modelId,
    provider: m?.provider ?? UNKNOWN.provider,
    region: m?.region ?? UNKNOWN.region,
    costMinor: ext.meta?.usage.costMinor ?? 0,
  };
  return handleEnquiry(inner, { ...e, fields: {}, provenance, extractionFailure: { code: ext.failure, detail: ext.detail } });
}
