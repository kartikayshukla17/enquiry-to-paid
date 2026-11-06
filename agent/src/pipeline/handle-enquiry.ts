import type { Pool } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { KernelError, NEGOTIATION_INTENTS, type Availability, type ExtractedFields, type Outcome, type TurnOutcome } from "../kernel/types.js";
import type { Notifier } from "../escalation/index.js";
import { appendEntry, type LedgerRow } from "../ledger/index.js";
import type { ReplyWorder } from "../llm/word-reply.js";
import { disclosureReply, holdingReply, renderReply, replyTemplate } from "./reply.js";
import { encryptPii, phoneHash, piiKeysFromEnv, type PiiKeys } from "../security/pii.js";
import { withTenant } from "../tenancy/with-tenant.js";

export interface EnquiryInput {
  tenant: { id: string; name: string };
  threadId: string;
  customerRef: string; // stable reference; hashed before it touches the DB
  rateCard: unknown;
  rateCardVersion: number;
  now: string;
  availability: Availability;
  message: string;
  /** This message's extracted fields; merged over the thread's earlier ones (later wins). */
  fields: Partial<ExtractedFields> & Record<string, unknown>;
  /** Model/provider/region/cost of the extraction call behind this message (fixture mode: none). */
  provenance?: Provenance;
  /** Extraction failed (provider error or schema-invalid output): nothing to merge, never a quote. */
  extractionFailure?: { code: string; detail: string };
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

/**
 * Typed fields -> kernel -> reply (numbers from kernel) -> ledger.
 * Free text (`message`) is stored in the ledger only; it never reaches the kernel.
 */
export async function handleEnquiry(
  deps: { pool: Pool; kernel: KernelBridge; notifier: Notifier; pii?: PiiKeys; worder?: ReplyWorder; lowConfidenceBps?: number },
  e: EnquiryInput,
): Promise<EnquiryResult> {
  const cardHash = deps.kernel.rateCardHash(e.rateCard);
  const pii = deps.pii ?? piiKeysFromEnv();
  const threshold = deps.lowConfidenceBps ?? lowConfidenceThreshold();
  // Everything below runs as the unprivileged app role with app.tenant_id set (RLS applies).
  const { outcome, reply, ledgerRow, fields, clarifying } = await withTenant(deps.pool, e.tenant.id, async (client) => {
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
    const cardId = (e.rateCard as { id: string }).id;
    await client.query(
      `INSERT INTO rate_cards (id, tenant_id, card_id, version, content_hash, compiled)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [`${e.tenant.id}:${cardId}:${e.rateCardVersion}`, e.tenant.id, cardId, e.rateCardVersion, cardHash, JSON.stringify(e.rateCard)],
    );
    const base = { tenantId: e.tenant.id, threadId: e.threadId, at: e.now };
    // Which provider/region saw the customer text is recorded on the enquiry row (cost sits on the call's own row).
    const seenBy = e.provenance ? { ...e.provenance, costMinor: 0 } : {};
    await appendEntry(client, deps.kernel, { ...base, type: "enquiry", payload: { text: e.message }, ...seenBy });

    let fields: ExtractedFields;
    let outcome: TurnOutcome;
    let reply: string;
    let clarifying = false;
    let wording: Provenance | undefined;
    if (gated) {
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
        const raw = deps.kernel.evaluate({
          rateCard: e.rateCard,
          fields: kernelFields,
          availability: e.availability,
          now: e.now,
        }) as Outcome | { ok: false; error: string };
        if (!("kind" in raw)) throw new KernelError(raw.error);
        outcome = raw;
        clarifying = outcome.kind === "refusal" && outcome.reason === "missing_required_field";
        reply = renderReply(outcome, fields, e.rateCard);
        const t = deps.worder ? replyTemplate(outcome, fields, e.rateCard) : undefined;
        if (deps.worder && t) {
          const w = await deps.worder(t.kind, t.template, t.values);
          reply = w.reply;
          wording = w.provenance;
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
      rateCardHash: cardHash,
      ...outcomeProv,
    });
    // A clarifying question keeps the thread open; the follow-up message completes it. A gated read leaves stored fields alone.
    const state = outcome.kind === "disclosure" ? (stored?.state ?? "open") : outcome.kind === "quote" ? "quoted" : clarifying ? "open" : "refused";
    if (gated) await client.query("UPDATE threads SET state = $2 WHERE id = $1", [e.threadId, state]);
    else await client.query("UPDATE threads SET state = $2, fields = $3::jsonb WHERE id = $1", [e.threadId, state, JSON.stringify(fields)]);
    return { outcome, reply, ledgerRow, fields, clarifying };
  });
  // After commit: the refusal is durable before anyone is told about it.
  if (outcome.kind === "refusal" && !clarifying) {
    await deps.notifier.notify({
      tenantId: e.tenant.id,
      threadId: e.threadId,
      at: e.now,
      reason: outcome.reason,
      ...(outcome.ruleGap !== undefined && { ruleGap: outcome.ruleGap }),
      fields,
    });
  }
  return { reply, outcome, ledgerRow, fields };
}
