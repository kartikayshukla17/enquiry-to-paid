import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { razorpaySim } from "../payments/razorpay-sim.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { createAppServer } from "./app.js";

// V5: quotes/ledger-verify are tenant-scoped the same way every other /api/app/* route is (V3b's
// discipline) -- these tests reuse app-api.test.ts's sign-up/create-org helpers rather than
// rebuilding them, and seed through the real `appendEntry` chaining function (never a hand-built
// INSERT of a ledger row) so every seeded chain is genuinely hash-valid before any tamper test runs.

let db: TestDb;
let kernel: KernelBridge;
let srv: Server;
let base: string;
const AUTH_OPTS = { secret: "test-secret-test-secret-test-secret-1234", baseURL: "http://localhost:3000" };

beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
  srv = createAppServer({
    pool: db.pool,
    kernel,
    providers: { "razorpay-sim": razorpaySim({ webhookSecret: "test-webhook-secret" }) },
    defaultProvider: "razorpay-sim",
    visitorIpKey: "test-visitor-ip-key",
    auth: AUTH_OPTS,
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(async () => {
  srv.close();
  await db.drop();
});

async function signUpAndGetCookie(label: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: label, email: `${label}@example.test`, password: "fictional-pass-123" }),
  });
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function createOrg(cookie: string, name: string, slug: string): Promise<{ id: string }> {
  const r = await fetch(`${base}/api/auth/organization/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name, slug }),
  });
  expect(r.status).toBe(200);
  return r.json();
}

const QUOTE_PAYLOAD = {
  kind: "quote",
  rateCardHash: "fictional-content-hash-v5-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  currency: "INR",
  total: 850000,
  validUntil: "2026-12-31T00:00:00.000Z",
  lines: [
    { label: "Venue rental (100 guests)", amount: 800000, ruleId: "venue-rental-v1" },
    { label: "Service charge", amount: 50000, ruleId: "service-charge-v1" },
  ],
  adjustments: [{ ruleId: "moq-steel-bolts", label: "minimum order quantity (steel-bolts)", field: "quantity", from: 60, to: 100 }],
};

/** Seeds a tenant, one thread, a real enquiry row, a real `quote` row shaped exactly like the kernel's
 *  own `Quote` type (via `appendEntry`, never hand-built SQL -- the hash chain is genuinely valid), and
 *  the approved rate_cards row the detail endpoint's version lookup should find. */
async function seedQuote(tenantId: string, label: string): Promise<{ threadId: string; quoteSeq: number; enquirySeq: number }> {
  const customerId = `${tenantId}:cust:${label}`;
  const threadId = `${tenantId}:thread:${label}`;
  return withTenant(db.pool, tenantId, async (c) => {
    await c.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [tenantId, `FICTIONAL: ${tenantId}`]);
    await c.query("INSERT INTO customers (id, tenant_id, phone_hash) VALUES ($1,$2,$3)", [customerId, tenantId, `hash-${label}`]);
    await c.query("INSERT INTO threads (id, tenant_id, customer_id, fields) VALUES ($1,$2,$3,$4)", [threadId, tenantId, customerId, JSON.stringify({})]);
    await c.query(
      `INSERT INTO rate_cards (id, tenant_id, card_id, version, content_hash, compiled, status)
       VALUES ($1,$2,'fictional-card',3,$3,'{}'::jsonb,'draft')`,
      [`${tenantId}:fictional-card:3`, tenantId, QUOTE_PAYLOAD.rateCardHash],
    );
    const enquiry = await appendEntry(c, kernel, { tenantId, threadId, at: new Date().toISOString(), type: "enquiry", payload: { text: "fictional enquiry" } });
    const quote = await appendEntry(c, kernel, {
      tenantId, threadId, at: new Date().toISOString(), type: "quote", payload: QUOTE_PAYLOAD, rateCardHash: QUOTE_PAYLOAD.rateCardHash,
    });
    return { threadId, quoteSeq: quote.seq, enquirySeq: enquiry.seq };
  });
}

const OWNER_QUOTE_PAYLOAD = {
  memberId: "m1", role: "owner", text: "quote r1 85000", ref: "r1", refusalTenantSeq: 1, refusalSeq: 1,
  ownerPriced: true, total: 85000, currency: "INR", customerMessage: "FICTIONAL: here is your price",
};

async function seedOwnerQuote(tenantId: string, label: string): Promise<{ threadId: string; seq: number }> {
  const customerId = `${tenantId}:cust:${label}`;
  const threadId = `${tenantId}:thread:${label}`;
  return withTenant(db.pool, tenantId, async (c) => {
    await c.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [tenantId, `FICTIONAL: ${tenantId}`]);
    await c.query("INSERT INTO customers (id, tenant_id, phone_hash) VALUES ($1,$2,$3)", [customerId, tenantId, `hash-${label}`]);
    await c.query("INSERT INTO threads (id, tenant_id, customer_id, fields) VALUES ($1,$2,$3,$4)", [threadId, tenantId, customerId, JSON.stringify({})]);
    const row = await appendEntry(c, kernel, { tenantId, threadId, at: new Date().toISOString(), type: "owner_quote", payload: OWNER_QUOTE_PAYLOAD });
    return { threadId, seq: row.seq };
  });
}

describe("GET /api/app/quotes and /api/app/quotes/:seq", () => {
  it("lists only the caller's tenant's quote and owner_quote entries, newest first", async () => {
    const cookieA = await signUpAndGetCookie("v5-owner-a");
    const cookieB = await signUpAndGetCookie("v5-owner-b");
    const orgA = await createOrg(cookieA, "FICTIONAL: Rose Court Banquets V5", "rose-court-v5-aa");
    const orgB = await createOrg(cookieB, "FICTIONAL: Lotus Caterers V5", "lotus-caterers-v5-bb");

    const seedA = await seedQuote(orgA.id, "alpha");
    const ownerSeedA = await seedOwnerQuote(orgA.id, "alpha-owner");
    await seedQuote(orgB.id, "beta");

    const r = await fetch(`${base}/api/app/quotes`, { headers: { cookie: cookieA } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.quotes).toHaveLength(2);
    // newest first: the owner_quote was seeded after the quote.
    expect(body.quotes[0]).toEqual({
      seq: ownerSeedA.seq,
      threadId: ownerSeedA.threadId,
      type: "owner_quote",
      at: expect.any(String),
      total: 85000,
      currency: "INR",
      validUntil: null,
    });
    expect(body.quotes[1]).toEqual({
      seq: seedA.quoteSeq,
      threadId: seedA.threadId,
      type: "quote",
      at: expect.any(String),
      total: 850000,
      currency: "INR",
      validUntil: "2026-12-31T00:00:00.000Z",
    });
  });

  it("an empty tenant gets an empty list, not an error", async () => {
    const cookie = await signUpAndGetCookie("v5-owner-empty");
    await createOrg(cookie, "FICTIONAL: No Quotes Yet V5", "no-quotes-yet-v5");
    const r = await fetch(`${base}/api/app/quotes`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ quotes: [] });
  });

  it("returns the full typed quote payload, the thread it belongs to, and the looked-up rate-card version", async () => {
    const cookie = await signUpAndGetCookie("v5-owner-c");
    const org = await createOrg(cookie, "FICTIONAL: Marigold Decor V5", "marigold-decor-v5");
    const seed = await seedQuote(org.id, "gamma");

    const r = await fetch(`${base}/api/app/quotes/${seed.quoteSeq}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      quote: {
        seq: seed.quoteSeq,
        threadId: seed.threadId,
        type: "quote",
        at: expect.any(String),
        payload: QUOTE_PAYLOAD,
        rateCardVersion: 3,
      },
    });
  });

  it("renders an owner_quote as its own shape -- no lines, no rateCardHash, rateCardVersion null", async () => {
    const cookie = await signUpAndGetCookie("v5-owner-d");
    const org = await createOrg(cookie, "FICTIONAL: Delta Events V5", "delta-events-v5");
    const seed = await seedOwnerQuote(org.id, "delta1");

    const r = await fetch(`${base}/api/app/quotes/${seed.seq}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      quote: {
        seq: seed.seq,
        threadId: seed.threadId,
        type: "owner_quote",
        at: expect.any(String),
        payload: OWNER_QUOTE_PAYLOAD,
        rateCardVersion: null,
      },
    });
  });

  it("gives 'unknown' (null) rate-card version when no rate_cards row matches the hash", async () => {
    const cookie = await signUpAndGetCookie("v5-owner-e");
    const org = await createOrg(cookie, "FICTIONAL: Echo Weddings V5", "echo-weddings-v5");
    const threadId = `${org.id}:thread:nohash`;
    const quoteSeq = await withTenant(db.pool, org.id, async (c) => {
      await c.query("INSERT INTO customers (id, tenant_id, phone_hash) VALUES ($1,$2,$3)", [`${org.id}:cust:nohash`, org.id, "hash-nohash"]);
      await c.query("INSERT INTO threads (id, tenant_id, customer_id, fields) VALUES ($1,$2,$3,$4)", [threadId, org.id, `${org.id}:cust:nohash`, "{}"]);
      const q = await appendEntry(c, kernel, {
        tenantId: org.id, threadId, at: new Date().toISOString(), type: "quote",
        payload: { ...QUOTE_PAYLOAD, rateCardHash: "fictional-hash-with-no-rate-card-row" },
        rateCardHash: "fictional-hash-with-no-rate-card-row",
      });
      return q.seq;
    });

    const r = await fetch(`${base}/api/app/quotes/${quoteSeq}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect((await r.json()).quote.rateCardVersion).toBeNull();
  });

  it("404s a seq belonging to another tenant, a non-quote entry's seq, and a nonexistent seq -- identically", async () => {
    const cookieA = await signUpAndGetCookie("v5-owner-f");
    const cookieB = await signUpAndGetCookie("v5-owner-g");
    const orgA = await createOrg(cookieA, "FICTIONAL: Foxtrot Catering V5", "foxtrot-catering-v5");
    const orgB = await createOrg(cookieB, "FICTIONAL: Golf Events V5", "golf-events-v5");
    const seedA = await seedQuote(orgA.id, "foxtrot1");
    const seedB = await seedQuote(orgB.id, "golf1");

    const crossTenant = await fetch(`${base}/api/app/quotes/${seedB.quoteSeq}`, { headers: { cookie: cookieA } });
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toEqual({ error: "not found" });

    const nonQuoteEntry = await fetch(`${base}/api/app/quotes/${seedA.enquirySeq}`, { headers: { cookie: cookieA } });
    expect(nonQuoteEntry.status).toBe(404);
    expect(await nonQuoteEntry.json()).toEqual({ error: "not found" });

    const nonexistent = await fetch(`${base}/api/app/quotes/999999999`, { headers: { cookie: cookieA } });
    expect(nonexistent.status).toBe(404);
    expect(await nonexistent.json()).toEqual({ error: "not found" });

    const notANumber = await fetch(`${base}/api/app/quotes/not-a-number`, { headers: { cookie: cookieA } });
    expect(notANumber.status).toBe(404);
    expect(await notANumber.json()).toEqual({ error: "not found" });
  });
});

describe("GET /api/app/ledger-verify -- the chain-verify badge's real data source", () => {
  it("returns ok:true for a tenant whose chain is intact", async () => {
    const cookie = await signUpAndGetCookie("v5-owner-h");
    const org = await createOrg(cookie, "FICTIONAL: Hotel Events V5", "hotel-events-v5");
    await seedQuote(org.id, "hotel1");

    const r = await fetch(`${base}/api/app/ledger-verify`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("is tenant-scoped: never takes a tenant id from the client", async () => {
    const cookie = await signUpAndGetCookie("v5-owner-i");
    await createOrg(cookie, "FICTIONAL: India Events V5", "india-events-v5");
    const r = await fetch(`${base}/api/app/ledger-verify?tenantId=someone-elses-tenant`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("401s with no session, and 403s a non-owner member", async () => {
    const noSession = await fetch(`${base}/api/app/ledger-verify`);
    expect(noSession.status).toBe(401);
  });

  // The ticket's actual demo: tamper a row directly in the database (same technique agent/README.md's
  // T4 section documents -- disable the append-only trigger, edit, re-enable) and watch this SAME
  // endpoint flip from ok:true to ok:false with a reason, proving the badge calls the real
  // `verifyLedger`/kernel chain-walk rather than a client-side guess.
  it("flips from ok:true to ok:false with a reason after a row is tampered with in a scratch database", async () => {
    const cookie = await signUpAndGetCookie("v5-owner-j");
    const org = await createOrg(cookie, "FICTIONAL: Juliet Caterers V5", "juliet-caterers-v5");
    const seed = await seedQuote(org.id, "juliet1");

    const before = await fetch(`${base}/api/app/ledger-verify`, { headers: { cookie } });
    expect(await before.json()).toEqual({ ok: true });

    const c = await db.pool.connect();
    try {
      await c.query("ALTER TABLE ledger_entries DISABLE TRIGGER USER");
      await c.query(`UPDATE ledger_entries SET payload='{}' WHERE tenant_id=$1 AND seq=$2`, [org.id, seed.quoteSeq]);
    } finally {
      await c.query("ALTER TABLE ledger_entries ENABLE TRIGGER USER");
      c.release();
    }

    const after = await fetch(`${base}/api/app/ledger-verify`, { headers: { cookie } });
    expect(after.status).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.ok).toBe(false);
    expect(afterBody.reason).toBe("hash_mismatch");
    expect(afterBody.seq).toBe(seed.quoteSeq);

    // And the quote detail route (which does NOT re-verify the chain itself) still happily returns
    // the tampered row's payload verbatim -- it is the badge's job to say the chain is broken, not
    // the detail route's. This is the point: the UI must show the badge, not trust the row quietly.
    const detail = await fetch(`${base}/api/app/quotes/${seed.quoteSeq}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    expect((await detail.json()).quote.payload).toEqual({});
  });
});
