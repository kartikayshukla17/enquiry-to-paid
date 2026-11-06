import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { KernelError, type Availability, type ExtractedFields, type Outcome } from "../kernel/types.js";
import type { Notifier } from "../escalation/index.js";
import { appendEntry, type LedgerRow } from "../ledger/index.js";
import { renderReply } from "./reply.js";

export interface EnquiryInput {
  tenant: { id: string; name: string };
  threadId: string;
  customerRef: string; // stable reference; hashed before it touches the DB
  rateCard: unknown;
  rateCardVersion: number;
  now: string;
  availability: Availability;
  message: string;
  fields: ExtractedFields;
  /** Model/provider/region/cost of the LLM calls behind this outcome (T6 supplies real values). */
  provenance?: Provenance;
}

export interface Provenance {
  modelId: string;
  provider: string;
  region: string;
  costMinor: number;
}

/** Fixture mode: no LLM was called, so the cost is honestly zero. */
export const FIXTURE_PROVENANCE: Provenance = { modelId: "fixture", provider: "fixture", region: "local", costMinor: 0 };

export interface EnquiryResult {
  reply: string;
  outcome: Outcome;
  ledgerRow: LedgerRow;
}

export const phoneHash = (ref: string) => createHash("sha256").update(`customer:${ref}`).digest("hex");

/**
 * T1 tracer: typed fields -> kernel -> reply (numbers from kernel) -> ledger.
 * Free text (`message`) is stored in the ledger only; it never reaches the kernel.
 */
export async function handleEnquiry(
  deps: { pool: Pool; kernel: KernelBridge; notifier: Notifier },
  e: EnquiryInput,
): Promise<EnquiryResult> {
  const raw = deps.kernel.evaluate({
    rateCard: e.rateCard,
    fields: e.fields,
    availability: e.availability,
    now: e.now,
  }) as Outcome | { ok: false; error: string };
  if (!("kind" in raw)) throw new KernelError(raw.error);
  const outcome: Outcome = raw;
  const reply = renderReply(outcome, e.fields);
  const cardHash = deps.kernel.rateCardHash(e.rateCard);

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [e.tenant.id, e.tenant.name]);
    const customerId = `${e.tenant.id}:cust:${e.customerRef}`;
    await client.query(
      `INSERT INTO customers (id, tenant_id, phone_hash, language) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [customerId, e.tenant.id, phoneHash(e.customerRef), e.fields.language],
    );
    await client.query(
      `INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [e.threadId, e.tenant.id, customerId],
    );
    const cardId = (e.rateCard as { id: string }).id;
    await client.query(
      `INSERT INTO rate_cards (id, tenant_id, card_id, version, content_hash, compiled)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [`${e.tenant.id}:${cardId}:${e.rateCardVersion}`, e.tenant.id, cardId, e.rateCardVersion, cardHash, JSON.stringify(e.rateCard)],
    );
    const base = { tenantId: e.tenant.id, threadId: e.threadId, at: e.now };
    await appendEntry(client, deps.kernel, { ...base, type: "enquiry", payload: { text: e.message } });
    await appendEntry(client, deps.kernel, { ...base, type: "extraction", payload: { fields: e.fields } });
    const ledgerRow = await appendEntry(client, deps.kernel, {
      ...base,
      type: outcome.kind,
      payload: outcome,
      rateCardHash: cardHash,
      ...(e.provenance ?? FIXTURE_PROVENANCE),
    });
    await client.query("UPDATE threads SET state = $2 WHERE id = $1", [e.threadId, outcome.kind === "quote" ? "quoted" : "refused"]);
    await client.query("COMMIT");
    // After commit: the refusal is durable before anyone is told about it.
    if (outcome.kind === "refusal") {
      await deps.notifier.notify({
        tenantId: e.tenant.id,
        threadId: e.threadId,
        at: e.now,
        reason: outcome.reason,
        ...(outcome.ruleGap !== undefined && { ruleGap: outcome.ruleGap }),
        fields: e.fields,
      });
    }
    return { reply, outcome, ledgerRow };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
