import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import type { CallMeta, ExtractResult, LlmProvider, WordReplyInput } from "../llm/types.js";
import { REPO_ROOT } from "../ratecard/paths.js";
import { customerRefFromPhone, handleWhatsAppWebhook } from "./webhook.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const SECRET = "test-only-whatsapp-app-secret-not-real";
const NOW = "2026-11-07T10:00:00Z";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

/** A Meta-shaped webhook envelope carrying exactly one inbound text message. */
function envelope(from: string, text: string, id = "wamid.TEST1") {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [{ value: { messaging_product: "whatsapp", metadata: { phone_number_id: "pn-1" }, messages: [{ from, id, type: "text", text: { body: text } }] }, field: "messages" }],
      },
    ],
  });
}

const statusOnlyEnvelope = () =>
  JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ value: { statuses: [{ id: "wamid.s1", status: "delivered" }] }, field: "messages" }] }] });

const META: CallMeta = { modelId: "test-model-1", provider: "testprov", region: "eu-test-1", usage: { tokens: 10, costMinor: 1 } };
/** Extraction is stubbed (same DI pattern `pipeline/handle-message.test.ts` already uses) -- the free text
 *  itself is irrelevant to these tests; only the pipeline's handling of the already-extracted fields is. */
function stubLlm(fields: Record<string, unknown>): LlmProvider {
  return {
    extract: () => Promise.resolve({ ...META, fields } as unknown as ExtractResult),
    wordReply: (i: WordReplyInput) => Promise.resolve({ ...META, text: i.template }),
  };
}

describe("handleWhatsAppWebhook: signature-first ordering", () => {
  it("rejects a bad signature before anything else runs: no parsing, no pipeline, no send", async () => {
    const send = vi.fn(async () => undefined);
    const tenantId = "tenant-wa-badsig";
    const body = envelope("919900000001", "quote please");
    const r = await handleWhatsAppWebhook(
      { pool: db.pool, appSecret: SECRET, send, tenantId, card: "rate-cards/fictional-banquet.json", llm: stubLlm({ service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9200, intent: "enquiry" }) },
      body,
      { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      NOW,
    );
    expect(r).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(send).not.toHaveBeenCalled();
    expect((await db.pool.query("SELECT 1 FROM customers WHERE tenant_id=$1", [tenantId])).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM ledger_entries WHERE tenant_id=$1", [tenantId])).rowCount).toBe(0);
  });

  it("a missing signature header is also rejected", async () => {
    const send = vi.fn(async () => undefined);
    const r = await handleWhatsAppWebhook({ pool: db.pool, appSecret: SECRET, send }, envelope("919900000002", "hi"), {}, NOW);
    expect(r).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(send).not.toHaveBeenCalled();
  });

  it("header case is normalised (Meta's own casing, X-Hub-Signature-256, still verifies)", async () => {
    const send = vi.fn(async () => undefined);
    const tenantId = "tenant-wa-headercase";
    const body = envelope("919900000006", "hello");
    const r = await handleWhatsAppWebhook(
      { pool: db.pool, appSecret: SECRET, send, tenantId, card: "rate-cards/fictional-banquet.json", llm: stubLlm({ service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9200, intent: "enquiry" }) },
      body,
      { "X-Hub-Signature-256": sign(body) },
      NOW,
    );
    expect(r.status).toBe("replied");
  });

  it("a valid signature shape but no app secret configured on this deployment never succeeds (degrades sanely, no crash)", async () => {
    const send = vi.fn(async () => undefined);
    const body = envelope("919900000003", "hi");
    const r = await handleWhatsAppWebhook({ pool: db.pool, appSecret: "", send }, body, { "x-hub-signature-256": sign(body) }, NOW);
    expect(r).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("handleWhatsAppWebhook: non-message payloads are acknowledged, not processed", () => {
  it("a status/delivery-receipt payload is ignored and nothing else happens", async () => {
    const send = vi.fn(async () => undefined);
    const body = statusOnlyEnvelope();
    const r = await handleWhatsAppWebhook({ pool: db.pool, appSecret: SECRET, send }, body, { "x-hub-signature-256": sign(body) }, NOW);
    expect(r).toEqual({ status: "ignored" });
    expect(send).not.toHaveBeenCalled();
  });

  it("a signed but malformed JSON body is also just ignored, never a throw", async () => {
    const send = vi.fn(async () => undefined);
    const body = "{not valid json";
    const r = await handleWhatsAppWebhook({ pool: db.pool, appSecret: SECRET, send }, body, { "x-hub-signature-256": sign(body) }, NOW);
    expect(r).toEqual({ status: "ignored" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("handleWhatsAppWebhook: all fictional cards round-trip from a sandbox number", () => {
  // Known-good extracted fields per card (same values each card's own quote fixture under agent/fixtures/
  // already uses), so extraction can be stubbed (handle-message.test.ts's own DI pattern) instead of needing
  // real/recorded LLM calls per card. If a new fictional card is added without an entry here, the guard test
  // below fails loudly rather than this suite silently skipping it.
  const CARD_FIELDS: Record<string, Record<string, unknown>> = {
    "rate-cards/fictional-banquet.json": { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9200, intent: "enquiry" },
    "rate-cards/fictional-banquet-seasonal.json": { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9200, intent: "enquiry" },
    "rate-cards/fictional-contractor.json": { service: "tap-repair", locality: "greater-noida-west", quantity: 1, language: "en", confidenceBps: 9200, intent: "enquiry" },
    "rate-cards/fictional-b2b-supplier.json": { service: "steel-bolts", quantity: 750, language: "en", confidenceBps: 9200, intent: "enquiry" },
    "rate-cards/fictional-photographer.json": { service: "wedding-shoot", date: "2026-12-09", package: "standard", hours: 6, distanceKm: 10, language: "en", confidenceBps: 9100, intent: "enquiry" },
  };
  const cards = readdirSync(`${REPO_ROOT}rate-cards`)
    .filter((f) => /^fictional-.*\.json$/.test(f))
    .map((f) => `rate-cards/${f}`);

  it("every fictional card under rate-cards/ has a known-good field set wired into this test", () => {
    expect(cards.sort()).toEqual(Object.keys(CARD_FIELDS).sort());
  });

  it.each(cards)("%s: quote in, a real send out, the raw phone number never lands anywhere stored", async (card) => {
    const send = vi.fn(async () => undefined);
    const phone = "919900001234";
    const tenantId = `tenant-wa-${card.split("fictional-")[1]!.replace(".json", "")}`;
    const body = envelope(phone, "free text is irrelevant here: extraction is stubbed");
    const r = await handleWhatsAppWebhook({ pool: db.pool, appSecret: SECRET, send, tenantId, card, llm: stubLlm(CARD_FIELDS[card]!) }, body, { "x-hub-signature-256": sign(body) }, NOW);

    expect(r.status).toBe("replied");
    expect(send).toHaveBeenCalledTimes(1);
    const [to, replyText] = send.mock.calls[0] as unknown as [string, string];
    expect(to).toBe(phone);
    expect(typeof replyText).toBe("string");
    expect(replyText.length).toBeGreaterThan(0);

    const threadId = (r as { threadId: string | null }).threadId;
    expect(threadId).toBeTruthy();
    const led = await db.pool.query<{ type: string }>("SELECT type FROM ledger_entries WHERE thread_id=$1 ORDER BY seq DESC LIMIT 1", [threadId]);
    expect(led.rows[0]?.type).toBe("quote");

    // the raw phone number never lands anywhere in this tenant's stored rows (customers.id is built directly
    // from customerRef by handle-enquiry.ts, which is exactly why customerRefFromPhone hashes it first)
    const customers = await db.pool.query<{ id: string; phone_hash: string }>("SELECT id, phone_hash FROM customers WHERE tenant_id=$1", [tenantId]);
    expect(customers.rowCount).toBeGreaterThan(0);
    for (const row of customers.rows) {
      expect(row.id).not.toContain(phone);
      expect(row.phone_hash).not.toContain(phone);
    }
    const ledgerText = JSON.stringify((await db.pool.query("SELECT payload FROM ledger_entries WHERE tenant_id=$1", [tenantId])).rows);
    expect(ledgerText).not.toContain(phone);
  });
});

describe("handleWhatsAppWebhook: customerRef derivation", () => {
  it("never returns the raw phone number, and is stable for the same number but distinct across numbers", () => {
    const ref = customerRefFromPhone("919900009999");
    expect(ref).not.toContain("919900009999");
    expect(ref.startsWith("wa-")).toBe(true);
    expect(ref).toBe(customerRefFromPhone("919900009999"));
    expect(ref).not.toBe(customerRefFromPhone("919900009998"));
  });
});

describe("handleWhatsAppWebhook: a thread paused for the owner", () => {
  it("sends nothing -- the customer's message is held, not relayed to the agent's reply path", async () => {
    const send = vi.fn(async () => undefined);
    const tenantId = "tenant-wa-held";
    const card = "rate-cards/fictional-banquet.json";
    const fields = { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9200, intent: "enquiry" };
    const phone = "919900007777";

    const firstBody = envelope(phone, "first message, gets a real quote");
    const r1 = await handleWhatsAppWebhook({ pool: db.pool, appSecret: SECRET, send, tenantId, card, llm: stubLlm(fields) }, firstBody, { "x-hub-signature-256": sign(firstBody) }, NOW);
    expect(r1.status).toBe("replied");
    const threadId = (r1 as { threadId: string }).threadId;

    // Pause the thread for the owner directly (same column `pipeline/handle-enquiry.ts` itself reads,
    // `threads.state`) -- cheaper than driving a full owner-takeover HTTP/ledger setup for this one check.
    await db.pool.query("UPDATE threads SET state='paused_owner' WHERE id=$1", [threadId]);
    send.mockClear();

    const secondBody = envelope(phone, "are you still there?");
    const r2 = await handleWhatsAppWebhook({ pool: db.pool, appSecret: SECRET, send, tenantId, card, llm: stubLlm(fields) }, secondBody, { "x-hub-signature-256": sign(secondBody) }, NOW);
    expect(r2).toEqual({ status: "held", threadId });
    expect(send).not.toHaveBeenCalled();
  });
});
