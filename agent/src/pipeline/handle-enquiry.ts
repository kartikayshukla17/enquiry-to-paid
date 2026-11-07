import type { Pool } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { KernelError, NEGOTIATION_INTENTS, type Availability, type ExtractedFields, type Outcome, type TurnOutcome } from "../kernel/types.js";
import type { Notifier } from "../escalation/index.js";
import { appendEntry, type LedgerRow } from "../ledger/index.js";
import { loadActiveCard } from "../ratecard/store.js";
import type { ReplyWorder, WordedReply } from "../llm/word-reply.js";
import type { ReplyKind } from "../llm/types.js";
import { defaultResource } from "../availability/native.js";
import type { AvailabilityProvider } from "../availability/types.js";
import { alternativeDates, holdHoursOf, offersAlternatives, priorQuoteExpired, timezoneOf } from "./availability-helpers.js";
import { EXPIRED_QUOTE_PREFIX, disclosureReply, formatInstantInZone, holdingReply, renderReply, replyTemplate, unavailableReply, type ReplyContext } from "./reply.js";
import { encryptPii, phoneHash, piiKeysFromEnv, type PiiKeys } from "../security/pii.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { readKillSwitch, type KillScope } from "../killswitch/index.js";
import { issuePaymentLinkInTxn } from "../payments/issue.js";
import { isCollectedState } from "../payments/webhook.js";
import type { PaymentProvider } from "../payments/types.js";

export interface EnquiryInput {
  tenant: { id: string; name: string };
  threadId: string;
  customerRef: string; // stable reference; hashed before it touches the DB
  rateCard: unknown;
  now: string;
  availability: Availability;
  message: string;
  /** This message's extracted fields; merged over the thread's earlier ones (later wins). */
  fields: Partial<ExtractedFields> & Record<string, unknown>;
  /** Model/provider/region/cost of the extraction call behind this message (fixture mode: none). */
  provenance?: Provenance;
  /** Extraction failed (provider error or schema-invalid output): nothing to merge, never a quote. */
  extractionFailure?: { code: string; detail: string };
  /** handleMessage saw the kill switch on before extraction (so no LLM ran). Conservative: stays on even if flipped off since. */
  killSwitchSeen?: { scope: KillScope };
}

export interface Provenance {
  modelId: string;
  provider: string;
  region: string;
  costMinor: number;
}

/** Fixture mode: no LLM was called, so the cost is honestly zero. */
export const FIXTURE_PROVENANCE: Provenance = { modelId: "fixture", provider: "fixture", region: "local", costMinor: 0 };

/** Below this the extraction is not acted on (basis points). Override per call, or with LOW_CONFIDENCE_BPS. */
export const DEFAULT_LOW_CONFIDENCE_BPS = 7000;
export function lowConfidenceThreshold(env: Record<string, string | undefined> = process.env): number {
  const raw = env.LOW_CONFIDENCE_BPS;
  if (raw === undefined || raw === "") return DEFAULT_LOW_CONFIDENCE_BPS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : DEFAULT_LOW_CONFIDENCE_BPS;
}

export interface EnquiryResult {
  reply: string;
  outcome: TurnOutcome;
  ledgerRow: LedgerRow;
  /** The thread's accumulated fields after merging this message. */
  fields: ExtractedFields;
}

/** Thrown inside the decision transaction (which then rolls back, leaving no trace) when the reply needs LLM wording. */
class NeedWording extends Error {
  constructor(
    readonly key: string,
    readonly kind: ReplyKind,
    readonly template: string,
    readonly values: Record<string, string>,
  ) {
    super("reply wording needed outside the transaction");
  }
}
const wordingKey = (kind: string, template: string, values: Record<string, string>): string => JSON.stringify([kind, template, values]);
const MAX_WORDING_ATTEMPTS = 3;

/**
 * Typed fields -> kernel -> reply (numbers from kernel) -> ledger.
 * Free text (`message`) is stored in the ledger only; it never reaches the kernel.
 */
export async function handleEnquiry(
  deps: { pool: Pool; kernel: KernelBridge; notifier: Notifier; pii?: PiiKeys; worder?: ReplyWorder; lowConfidenceBps?: number; availability?: AvailabilityProvider; payments?: PaymentProvider },
  e: EnquiryInput,
): Promise<EnquiryResult> {
  const pii = deps.pii ?? piiKeysFromEnv();
  const threshold = deps.lowConfidenceBps ?? lowConfidenceThreshold();
  // No LLM/network call may run while a DB transaction is open. The decision runs in a short transaction; if the
  // reply needs LLM wording, that transaction is rolled back (nothing was committed), the wording is fetched with
  // no transaction open, and the decision is re-run with the wording in hand. The decision is deterministic for
  // the same thread state, so the committed result is byte-identical to wording it in-line; if the state moved
  // between the attempts the wording is requested again, and after a few attempts the plain template is used.
  let pre: { key: string; w: WordedReply } | undefined;
  let decided: Decision | undefined;
  for (let attempt = 1; decided === undefined; attempt++) {
    try {
      decided = await decide(deps, e, pii, threshold, pre, attempt < MAX_WORDING_ATTEMPTS);
    } catch (err) {
      if (!(err instanceof NeedWording) || !deps.worder) throw err;
      pre = { key: err.key, w: await deps.worder(err.kind, err.template, err.values) };
    }
  }
  const { outcome, reply, ledgerRow, fields, clarifying } = decided;
  // After commit: the refusal is durable before anyone is told about it.
  if (outcome.kind === "refusal" && !clarifying) {
    await deps.notifier.notify({
      tenantId: e.tenant.id,
      threadId: e.threadId,
      at: e.now,
      reason: outcome.reason,
      ...(outcome.ruleGap !== undefined && { ruleGap: outcome.ruleGap }),
      ...(outcome.suggestion !== undefined && { suggestion: outcome.suggestion }),
      fields,
    });
  }
  return { reply, outcome, ledgerRow, fields };
}

interface Decision {
  outcome: TurnOutcome;
  reply: string;
  ledgerRow: LedgerRow;
  fields: ExtractedFields;
  clarifying: boolean;
}

type Deps = { pool: Pool; kernel: KernelBridge; notifier: Notifier; pii?: PiiKeys; worder?: ReplyWorder; lowConfidenceBps?: number; availability?: AvailabilityProvider; payments?: PaymentProvider };

async function decide(
  deps: Deps,
  e: EnquiryInput,
  pii: PiiKeys,
  threshold: number,
  pre: { key: string; w: WordedReply } | undefined,
  mayRequestWording: boolean,
): Promise<Decision> {
  // Everything below runs as the unprivileged app role with app.tenant_id set (RLS applies).
  return withTenant(deps.pool, e.tenant.id, async (client) => {
    await client.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [e.tenant.id, e.tenant.name]);
    const customerId = `${e.tenant.id}:cust:${e.customerRef}`;
    await client.query(
      `INSERT INTO customers (id, tenant_id, phone_hash, phone_enc, language) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [customerId, e.tenant.id, phoneHash(pii, e.customerRef), encryptPii(pii, e.customerRef), e.fields.language ?? null],
    );
    await client.query(
      `INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [e.threadId, e.tenant.id, customerId],
    );
    // Lock the thread row so concurrent messages merge in order; later fields override earlier ones.
    const stored = (await client.query<{ fields: Record<string, unknown>; state: string }>("SELECT fields, state FROM threads WHERE id = $1 FOR UPDATE", [e.threadId])).rows[0];
    // The intent is a per-message classification: it never merges into (or is read back from) the thread.
    const { intent, ...messageFields } = e.fields;
    const isBotQuestion = intent === "asks_if_bot";
    const failure = e.extractionFailure;
    const lowConf = !failure && typeof e.fields.confidenceBps === "number" && e.fields.confidenceBps < threshold;
    const gated = failure !== undefined || lowConf;
    // Activation gate: the pipeline quotes only from the tenant's APPROVED snapshot of this card, re-hashed by the kernel.
    // The card the caller passed names which card is meant (`id`); its content is never used to price.
    // Kill switch: read inside this transaction, before the card gate and the kernel. While on, nothing below the
    // kill branch runs, so no quote and no hold are possible.
    const ks = await readKillSwitch(client, e.tenant.id);
    const killed = ks.on ? ks : e.killSwitchSeen ? { on: true as const, scope: e.killSwitchSeen.scope } : undefined;
    const gate = await loadActiveCard(client, deps.kernel, e.tenant.id, (e.rateCard as { id: string }).id);
    const card: unknown = gate.ok ? gate.card : e.rateCard;
    const cardHash = gate.ok ? gate.hash : undefined;
    // An honest "are you a bot?" answer prices nothing, so it needs no approved card.
    const cardBlocked = !gate.ok && !isBotQuestion;
    const base = { tenantId: e.tenant.id, threadId: e.threadId, at: e.now };
    // Which provider/region saw the customer text is recorded on the enquiry row (cost sits on the call's own row).
    const seenBy = e.provenance ? { ...e.provenance, costMinor: 0 } : {};
    await appendEntry(client, deps.kernel, { ...base, type: "enquiry", payload: { text: e.message }, ...seenBy });

    let fields: ExtractedFields;
    let outcome: TurnOutcome;
    let reply: string;
    let clarifying = false;
    const holdEvents: { threadId: string; payload: Record<string, unknown> }[] = [];
    let wording: Provenance | undefined;
    if (killed) {
      // Refuse-everything mode: typed refusal, holding reply, escalation (after commit). The message text is only logged;
      // nothing merges into the thread, no card is priced, no hold is placed.
      fields = (stored?.fields as unknown as ExtractedFields | undefined) ?? { language: "unknown", confidenceBps: 0 };
      outcome = { kind: "refusal", reason: "kill_switch", ruleGap: `kill_switch_${killed.scope}` };
      reply = holdingReply("kill_switch");
      await appendEntry(client, deps.kernel, {
        ...base,
        type: "extraction",
        payload: { status: "kill_switch", scope: killed.scope },
        ...(e.provenance ?? FIXTURE_PROVENANCE),
      });
    } else if (isCollectedState(stored?.state)) {
      // Terminal: the job is paid for. A later message neither re-quotes, issues another link nor reopens the thread; a human takes it.
      fields = (stored?.fields as unknown as ExtractedFields | undefined) ?? { language: "unknown", confidenceBps: 0 };
      outcome = { kind: "refusal", reason: "out_of_policy", ruleGap: "thread_already_collected" };
      reply = holdingReply("out_of_policy");
      await appendEntry(client, deps.kernel, {
        ...base,
        type: "extraction",
        payload: { status: "thread_collected" },
        ...(e.provenance ?? FIXTURE_PROVENANCE),
      });
    } else if (gated) {
      // Gate: this read is untrusted. Nothing merges into the thread, the kernel is not consulted, no quote is possible.
      fields = (stored?.fields as unknown as ExtractedFields | undefined) ?? { language: "unknown", confidenceBps: 0 };
      outcome = { kind: "refusal", reason: "low_confidence", ...(failure && { ruleGap: `extraction_${failure.code}` }) };
      reply = holdingReply("low_confidence");
      await appendEntry(client, deps.kernel, {
        ...base,
        type: "extraction",
        payload: failure
          ? { status: "rejected", failure: failure.code, detail: failure.detail }
          : { status: "low_confidence", thresholdBps: threshold, fields: e.fields },
        ...(e.provenance ?? FIXTURE_PROVENANCE),
      });
    } else if (cardBlocked && !gate.ok) {
      // No approved, intact card: the kernel is not consulted and no quote is possible. The owner is told via escalation.
      // The typed fields are still remembered (they are only data), so the owner's escalation carries them.
      const merged = { ...(stored?.fields ?? {}), ...messageFields } as Record<string, unknown>;
      fields = typeof merged.language === "string" && typeof merged.confidenceBps === "number" ? (merged as unknown as ExtractedFields) : { language: "unknown", confidenceBps: 0 };
      outcome = { kind: "refusal", reason: "out_of_policy", ruleGap: gate.gap };
      reply = holdingReply("out_of_policy");
      await appendEntry(client, deps.kernel, {
        ...base,
        type: "extraction",
        payload: { status: "card_unavailable", gap: gate.gap },
        ...(e.provenance ?? FIXTURE_PROVENANCE),
      });
    } else {
      const merged = { ...(stored?.fields ?? {}), ...messageFields } as Record<string, unknown>;
      if (typeof merged.language !== "string" || typeof merged.confidenceBps !== "number") {
        throw new Error("extraction must carry language and confidenceBps");
      }
      fields = merged as unknown as ExtractedFields;
      if (isBotQuestion) {
        // Honest disclosure: static wording, no kernel call, no quote forced, no escalation. The thread stays as it was.
        outcome = { kind: "disclosure" };
        reply = disclosureReply(fields.language, e.tenant.name);
      } else {
        // Only a typed negotiation intent crosses to the kernel (as an enum value); the kernel owns the refusal.
        const kernelFields = intent !== undefined && (NEGOTIATION_INTENTS as readonly unknown[]).includes(intent) ? { ...fields, intent } : fields;
        const evaluate = (blockedDates: string[], onDate?: string): Outcome => {
          const raw = deps.kernel.evaluate({
            rateCard: card,
            fields: onDate ? { ...kernelFields, date: onDate } : kernelFields,
            availability: { blockedDates },
            now: e.now,
          }) as Outcome | { ok: false; error: string };
          if (!("kind" in raw)) throw new KernelError(raw.error);
          return raw;
        };
        // Availability is read before the kernel: the provider's blocked dates join the caller's static ones.
        const provider = deps.availability;
        const date = typeof fields.date === "string" ? fields.date : undefined;
        const resourceId = provider && date ? await defaultResource(client, e.tenant.id) : undefined;
        const blocked = [...e.availability.blockedDates];
        if (provider && date && resourceId) {
          blocked.push(...(await provider.blockedDates(client, { tenantId: e.tenant.id, resourceId, from: date, to: date, now: e.now, ignoreThreadId: e.threadId })));
        }
        outcome = evaluate(blocked);
        // A quote and its hold are one atomic step: if the hold cannot be placed (a concurrent enquiry won the date),
        // the kernel is asked again with the date blocked and the quote is never issued.
        let holdUntil: string | undefined;
        if (outcome.kind === "quote" && provider && date && resourceId) {
          const expiresAt = new Date(Date.parse(e.now) + holdHoursOf(card) * 3_600_000).toISOString();
          const placed = await provider.placeHold(client, { tenantId: e.tenant.id, resourceId, threadId: e.threadId, start: date, end: date, expiresAt, now: e.now });
          if (!placed.ok) {
            outcome = evaluate([...blocked, date]);
          } else {
            holdUntil = placed.hold.expiresAt;
            for (const h of placed.sweptExpired) holdEvents.push({ threadId: h.threadId, payload: { action: "expired", holdId: h.id, resourceId: h.resourceId, start: h.start, end: h.end, expiresAt: h.expiresAt } });
            if (!placed.reused) holdEvents.push({ threadId: e.threadId, payload: { action: "placed", holdId: placed.hold.id, resourceId, start: date, end: date, expiresAt: holdUntil } });
          }
        }
        clarifying = outcome.kind === "refusal" && outcome.reason === "missing_required_field";
        const ctx: ReplyContext = holdUntil !== undefined ? { holdUntil: formatInstantInZone(holdUntil, timezoneOf(card)) } : {};
        const priorExpired = (outcome.kind === "quote" || outcome.reason === "date_unavailable") && (await priorQuoteExpired(client, e.threadId, e.now));
        const prefix = priorExpired ? EXPIRED_QUOTE_PREFIX : "";
        if (outcome.kind === "refusal" && outcome.reason === "date_unavailable" && date) {
          const alts = provider && resourceId && offersAlternatives(card) ? await alternativeDates(client, provider, evaluate, { tenantId: e.tenant.id, resourceId, threadId: e.threadId, date, now: e.now, blocked }) : [];
          reply = prefix + unavailableReply(date, alts);
        } else {
          reply = prefix + renderReply(outcome, fields, card, ctx);
          const t = deps.worder ? replyTemplate(outcome, fields, card, ctx) : undefined;
          if (deps.worder && t) {
            const key = wordingKey(t.kind, t.template, t.values);
            if (pre?.key === key) {
              reply = prefix + pre.w.reply;
              wording = pre.w.provenance;
            } else if (mayRequestWording) {
              throw new NeedWording(key, t.kind, t.template, t.values);
            } // else: the state keeps moving under us; the plain kernel-derived reply stands
          }
        }
      }
      await appendEntry(client, deps.kernel, {
        ...base,
        type: "extraction",
        payload: { fields: e.fields, merged: fields },
        ...(e.provenance ?? {}),
      });
    }
    // Per-call cost: the extraction row carries the extraction call's cost, this row the wording call's (0 when none),
    // so SUM(cost_minor) over a thread is the thread's LLM spend.
    const outcomeProv: Provenance = wording ?? (e.provenance ? { ...e.provenance, costMinor: 0 } : FIXTURE_PROVENANCE);
    const ledgerRow = await appendEntry(client, deps.kernel, {
      ...base,
      type: outcome.kind,
      payload: outcome,
      ...(cardHash !== undefined && { rateCardHash: cardHash }),
      ...outcomeProv,
    });
    for (const h of holdEvents) await appendEntry(client, deps.kernel, { ...base, threadId: h.threadId, type: "hold", payload: h.payload });
    // Payment link: code-written, appended after any model wording, for exactly the kernel total. Never while the kill switch
    // is on (`killed` is already false on this path, and issuePaymentLinkInTxn re-reads the flag itself).
    if (outcome.kind === "quote" && deps.payments && !killed) {
      const issued = await issuePaymentLinkInTxn(client, deps.kernel, deps.payments, {
        tenantId: e.tenant.id, threadId: e.threadId, quote: { seq: ledgerRow.seq, amountMinor: outcome.total, currency: outcome.currency }, now: e.now,
      });
      if (issued.ok) reply = `${reply}\n\n${issued.link.replyText}`;
    }
    // A clarifying question keeps the thread open; the follow-up message completes it. A gated read leaves stored fields alone.
    const state = outcome.kind === "disclosure" ? (stored?.state ?? "open") : outcome.kind === "quote" ? "quoted" : clarifying ? "open" : "refused";
    if (isCollectedState(stored?.state)) { /* terminal: state and fields stay as they are */ }
    else if (gated || killed) await client.query("UPDATE threads SET state = $2 WHERE id = $1", [e.threadId, state]);
    else await client.query("UPDATE threads SET state = $2, fields = $3::jsonb WHERE id = $1", [e.threadId, state, JSON.stringify(fields)]);
    return { outcome, reply, ledgerRow, fields, clarifying };
  });
}
