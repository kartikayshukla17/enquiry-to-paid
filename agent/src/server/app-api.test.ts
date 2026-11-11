import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth, type E2pAuth } from "../auth/index.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { razorpaySim } from "../payments/razorpay-sim.js";
import { encryptPii, piiKeysFromEnv } from "../security/pii.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { createAppServer } from "./app.js";
import { maskCustomerRef } from "./mask-customer-ref.js";

// V4: every seeded customer gets a real (fictional) phone number encrypted into phone_enc, the
// way the real pipeline always does, so these tests exercise the same decrypt-then-mask path the
// owner console actually uses rather than the no-ciphertext fallback.
const FICTIONAL_PHONE = "+91 98765 43210";

// V3b: /api/app/* is read-only and tenant-scoped. Every route resolves session -> active org (the
// tenant id) -> owner role in the app's `members` table, then reads through withTenant (RLS). The
// Done-when this file exists to prove: no endpoint ever takes a tenant id from the client -- not a
// header, not a query param, not a body field. It is always the session-derived active org.

let db: TestDb;
let kernel: KernelBridge;
let srv: Server;
let base: string;
// A second Better Auth instance, same pool/secret/baseURL as the server's own, used ONLY to seed
// server-side state (auth.api.addMember is server-only -- there is no HTTP endpoint for it) exactly
// the way agent/src/auth/auth.test.ts does. It shares sessions with the server because both read/write
// the same DB tables with the same secret; the test never uses it to bypass HTTP for anything this
// ticket's routes actually do.
let seedAuth: E2pAuth;
const AUTH_OPTS = { secret: "test-secret-test-secret-test-secret-1234", baseURL: "http://localhost:3000" };

beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
  seedAuth = createAuth(db.pool, AUTH_OPTS);
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

async function addManager(organizationId: string, email: string): Promise<void> {
  const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "manager-fictional", email, password: "fictional-pass-123" }),
  });
  const userId = (await signUp.json()).user.id as string;
  // addMember is server-only in Better Auth (no HTTP route); seed it the same way auth.test.ts does.
  await seedAuth.api.addMember({ body: { organizationId, userId, role: "manager" } });
}

/** Seeds one thread (with two ledger entries) and one payment directly, the way the real pipeline would. */
async function seedThread(tenantId: string, label: string, phone = FICTIONAL_PHONE): Promise<{ threadId: string; paymentId: string; quoteLedgerSeq: number }> {
  const customerId = `${tenantId}:cust:${label}`;
  const threadId = `${tenantId}:thread:${label}`;
  const pii = piiKeysFromEnv();
  let quoteLedgerSeq = 0;
  await withTenant(db.pool, tenantId, async (c) => {
    await c.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [tenantId, `FICTIONAL: ${tenantId}`]);
    await c.query("INSERT INTO customers (id, tenant_id, phone_hash, phone_enc) VALUES ($1,$2,$3,$4)", [customerId, tenantId, `hash-${label}`, encryptPii(pii, phone)]);
    await c.query("INSERT INTO threads (id, tenant_id, customer_id, fields) VALUES ($1,$2,$3,$4)", [threadId, tenantId, customerId, JSON.stringify({ guests: 100 })]);
    const first = await appendEntry(c, kernel, { tenantId, threadId, at: new Date().toISOString(), type: "enquiry", payload: { text: "fictional enquiry" } });
    await appendEntry(c, kernel, { tenantId, threadId, at: new Date().toISOString(), type: "quote", payload: { total: 50000, currency: "INR" } });
    const paymentId = `${threadId}:pay1`;
    quoteLedgerSeq = first.seq;
    await c.query(
      `INSERT INTO payments (id, tenant_id, thread_id, quote_ledger_seq, provider, provider_link_id, link_url, amount_minor, currency, status, created_at)
       VALUES ($1,$2,$3,$4,'razorpay-sim','link-1','https://pay.example.test/link-1',50000,'INR','created',now())`,
      [paymentId, tenantId, threadId, first.seq],
    );
  });
  return { threadId, paymentId: `${threadId}:pay1`, quoteLedgerSeq };
}

describe("GET /api/app/* is tenant-scoped to the session's active org, owner-only", () => {
  it("401s with no session at all", async () => {
    const r = await fetch(`${base}/api/app/threads`);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "not signed in" });
  });

  it("401s a signed-in session that has no active organization yet", async () => {
    const cookie = await signUpAndGetCookie("v3b-no-org");
    const r = await fetch(`${base}/api/app/threads`, { headers: { cookie } });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "not signed in" });
  });

  it("returns only the caller's own tenant's threads, and 404s a thread id belonging to another tenant", async () => {
    const cookieA = await signUpAndGetCookie("v3b-owner-a");
    const cookieB = await signUpAndGetCookie("v3b-owner-b");
    const orgA = await createOrg(cookieA, "FICTIONAL: Rose Court Banquets", "rose-court-v3b-aa");
    const orgB = await createOrg(cookieB, "FICTIONAL: Lotus Caterers", "lotus-caterers-v3b-bb");

    const seedA = await seedThread(orgA.id, "alpha");
    const seedB = await seedThread(orgB.id, "beta");

    const listA = await fetch(`${base}/api/app/threads`, { headers: { cookie: cookieA } });
    expect(listA.status).toBe(200);
    const bodyA = await listA.json();
    expect(bodyA.threads).toHaveLength(1);
    expect(bodyA.threads[0]).toEqual({
      id: seedA.threadId,
      state: "open",
      createdAt: expect.any(String),
      customerId: `${orgA.id}:cust:alpha`,
      maskedCustomerRef: maskCustomerRef(FICTIONAL_PHONE),
      lastMessageSummary: "Quoted ₹500",
    });

    // Tenant A's owner, asking for tenant B's thread id directly -> 404, not tenant B's row, not a 403.
    const crossTenant = await fetch(`${base}/api/app/threads/${encodeURIComponent(seedB.threadId)}`, { headers: { cookie: cookieA } });
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toEqual({ error: "not found" });

    // Same wrong-tenant id, but tried via every channel a client could use to smuggle a tenant id in:
    // a query param, a custom header, and (on the list route, which ignores body) nothing to smuggle into.
    const viaQuery = await fetch(`${base}/api/app/threads/${encodeURIComponent(seedA.threadId)}?tenantId=${encodeURIComponent(orgB.id)}&tenant=${encodeURIComponent(orgB.id)}`, { headers: { cookie: cookieA } });
    expect(viaQuery.status).toBe(200);
    expect((await viaQuery.json()).thread.id).toBe(seedA.threadId); // query param is ignored, not honoured

    const viaHeader = await fetch(`${base}/api/app/threads/${encodeURIComponent(seedA.threadId)}`, { headers: { cookie: cookieA, "x-tenant-id": orgB.id } });
    expect(viaHeader.status).toBe(200);
    expect((await viaHeader.json()).thread.id).toBe(seedA.threadId); // header is ignored, not honoured

    // A nonexistent thread id entirely gets the identical 404 shape -- existence is never leaked.
    const notFound = await fetch(`${base}/api/app/threads/nonexistent-thread-id`, { headers: { cookie: cookieA } });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: "not found" });
  });

  it("GET /api/app/threads/:id returns the thread and its ledger entries ordered by seq ascending", async () => {
    const cookie = await signUpAndGetCookie("v3b-owner-c");
    const org = await createOrg(cookie, "FICTIONAL: Marigold Decor", "marigold-decor-v3b-cc");
    const seed = await seedThread(org.id, "gamma");

    const r = await fetch(`${base}/api/app/threads/${encodeURIComponent(seed.threadId)}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.thread).toEqual({
      id: seed.threadId,
      state: "open",
      createdAt: expect.any(String),
      customerId: `${org.id}:cust:gamma`,
      fields: { guests: 100 },
      maskedCustomerRef: maskCustomerRef(FICTIONAL_PHONE),
      lastMessageSummary: "Quoted ₹500",
    });
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((e: { type: string }) => e.type)).toEqual(["enquiry", "quote"]);
    expect(body.entries[0]).toEqual({
      seq: expect.any(Number),
      at: expect.any(String),
      type: "enquiry",
      payload: { text: "fictional enquiry" },
      rateCardHash: null,
      modelId: null,
      provider: null,
      region: null,
      costMinor: null,
      summary: "fictional enquiry",
    });
    expect(body.entries[0].seq).toBeLessThan(body.entries[1].seq);
  });

  it("GET /api/app/payments returns only the caller's tenant's payments, newest first", async () => {
    const cookieA = await signUpAndGetCookie("v3b-owner-d");
    const cookieB = await signUpAndGetCookie("v3b-owner-e");
    const orgA = await createOrg(cookieA, "FICTIONAL: Delta Events", "delta-events-v3b-dd");
    const orgB = await createOrg(cookieB, "FICTIONAL: Echo Weddings", "echo-weddings-v3b-ee");
    const seedA = await seedThread(orgA.id, "delta1");
    await seedThread(orgB.id, "echo1");

    const r = await fetch(`${base}/api/app/payments`, { headers: { cookie: cookieA } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toEqual({
      id: seedA.paymentId,
      threadId: seedA.threadId,
      quoteLedgerSeq: seedA.quoteLedgerSeq,
      provider: "razorpay-sim",
      amountMinor: 50000,
      currency: "INR",
      status: "created",
      createdAt: expect.any(String),
      collectedAt: null,
    });
  });

  it("an empty tenant gets empty lists, not an error", async () => {
    const cookie = await signUpAndGetCookie("v3b-owner-empty");
    await createOrg(cookie, "FICTIONAL: No Threads Yet", "no-threads-yet-v3b");
    const threads = await fetch(`${base}/api/app/threads`, { headers: { cookie } });
    expect(await threads.json()).toEqual({ threads: [] });
    const payments = await fetch(`${base}/api/app/payments`, { headers: { cookie } });
    expect(await payments.json()).toEqual({ payments: [] });
  });

  it("403s a non-owner member (manager) of the active org", async () => {
    const cookieOwner = await signUpAndGetCookie("v3b-owner-f");
    const org = await createOrg(cookieOwner, "FICTIONAL: Foxtrot Catering", "foxtrot-catering-v3b");
    const managerEmail = "v3b-manager-f@example.test";
    await addManager(org.id, managerEmail);

    const managerSignIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: managerEmail, password: "fictional-pass-123" }),
    });
    const managerCookie = managerSignIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    // addMember does not change the manager's own active org, so set it explicitly the real way: Better Auth's
    // own set-active endpoint -- never by a client-asserted tenant id.
    await fetch(`${base}/api/auth/organization/set-active`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: managerCookie },
      body: JSON.stringify({ organizationId: org.id }),
    });

    const r = await fetch(`${base}/api/app/threads`, { headers: { cookie: managerCookie } });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "owner only" });
  });

  it("404s anything else under /api/app/*", async () => {
    const cookie = await signUpAndGetCookie("v3b-owner-g");
    await createOrg(cookie, "FICTIONAL: Golf Events", "golf-events-v3b");
    const r = await fetch(`${base}/api/app/nope`, { headers: { cookie } });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
  });

  // V4 Done-when, same regex idea as simulator/run-fixture.test.ts's "never stores or prints a raw
  // phone number": the seeded customer's ref IS a realistic fictional phone number, so phone_enc
  // really does decrypt to something phone-shaped -- proving the masking actually fires, not just
  // that nothing phone-shaped happened to be in the fixture.
  it("never puts a raw phone number in GET /api/app/threads or GET /api/app/threads/:id, only the masked form", async () => {
    const cookie = await signUpAndGetCookie("v4-owner-h");
    const org = await createOrg(cookie, "FICTIONAL: Hotel Events", "hotel-events-v4");
    const seed = await seedThread(org.id, "phoneproof", FICTIONAL_PHONE);

    const list = await fetch(`${base}/api/app/threads`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(JSON.stringify(listBody)).not.toMatch(/\+\d{10,}|\b[6-9]\d{9}\b/);
    expect(JSON.stringify(listBody)).toContain(maskCustomerRef(FICTIONAL_PHONE));

    const detail = await fetch(`${base}/api/app/threads/${encodeURIComponent(seed.threadId)}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(JSON.stringify(detailBody)).not.toMatch(/\+\d{10,}|\b[6-9]\d{9}\b/);
    expect(JSON.stringify(detailBody)).toContain(maskCustomerRef(FICTIONAL_PHONE));
  });
});
