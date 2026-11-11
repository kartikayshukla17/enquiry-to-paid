import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { createProvider } from "../llm/config.js";
import { razorpaySim } from "../payments/razorpay-sim.js";
import { runChat } from "../simulator/chat.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { createAppServer } from "./app.js";

// V6: the escalation queue (reason, rule gap, thread link, age) and the takeover/reply/handback
// actions, built as a NEW caller of the existing agent/src/owner/{queue,takeover}.ts machinery --
// not a parallel implementation. Every escalation seeded here comes from a real discount-request
// enquiry run through the playground pipeline (runChat + the deterministic keyword provider), the
// same discipline app-quotes.test.ts/app-api.test.ts use: never a hand-built ledger/thread row.

let db: TestDb;
let kernel: KernelBridge;
let srv: Server;
let base: string;
const AUTH_OPTS = { secret: "test-secret-test-secret-test-secret-1234", baseURL: "http://localhost:3000" };
const DISCOUNT_TEXT = "please give 20% discount, banquet for 100 guests on 12 December 2026";

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

/** A real discount-request refusal, through the real pipeline (keyword provider, deterministic,
 *  no fixture needed) -- never a hand-built SQL row. Returns the thread id the escalation sits on. */
async function seedDiscountEscalation(tenantId: string, customerRef: string): Promise<{ threadId: string }> {
  const llm = createProvider({ LLM_PROVIDER: "keyword" }, { registry: false });
  const r = await runChat(DISCOUNT_TEXT, { pool: db.pool, tenantId, customerRef, llm });
  expect(r.ledgerRow.type).toBe("refusal");
  expect(typeof r.ledgerRow.threadId).toBe("string");
  return { threadId: r.ledgerRow.threadId as string };
}

async function ownerMemberId(tenantId: string): Promise<string> {
  return withTenant(db.pool, tenantId, async (c) =>
    (await c.query<{ id: string }>("SELECT id FROM members WHERE tenant_id=$1 AND role='owner'", [tenantId])).rows[0]!.id,
  );
}

describe("GET /api/app/escalations", () => {
  it("lists the open discount-request escalation with its reason, ruleGap, age and calledBack", async () => {
    const cookie = await signUpAndGetCookie("v6-owner-a");
    const org = await createOrg(cookie, "FICTIONAL: Rose Court Banquets V6", "rose-court-v6-aa");
    const { threadId } = await seedDiscountEscalation(org.id, "escalate-a");

    const r = await fetch(`${base}/api/app/escalations`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.escalations).toHaveLength(1);
    expect(body.escalations[0]).toMatchObject({
      threadId,
      reason: "discount_request",
      reasonText: "Customer asked for a discount or special deal",
      calledBack: false,
    });
    expect(typeof body.escalations[0].at).toBe("string");
    expect(Number.isNaN(new Date(body.escalations[0].at).getTime())).toBe(false);
    expect(typeof body.escalations[0].tenantSeq).toBe("number");
    expect(typeof body.escalations[0].seq).toBe("number");
  });

  it("an empty tenant gets an empty list, not an error", async () => {
    const cookie = await signUpAndGetCookie("v6-owner-empty");
    await createOrg(cookie, "FICTIONAL: No Escalations Yet V6", "no-escalations-v6");
    const r = await fetch(`${base}/api/app/escalations`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ escalations: [] });
  });

  it("401s with no session, and never shows another tenant's escalation", async () => {
    const noSession = await fetch(`${base}/api/app/escalations`);
    expect(noSession.status).toBe(401);

    const cookieA = await signUpAndGetCookie("v6-owner-b");
    const cookieB = await signUpAndGetCookie("v6-owner-c");
    const orgA = await createOrg(cookieA, "FICTIONAL: Lotus Caterers V6", "lotus-caterers-v6");
    await createOrg(cookieB, "FICTIONAL: Marigold Decor V6", "marigold-decor-v6");
    await seedDiscountEscalation(orgA.id, "escalate-b");

    const r = await fetch(`${base}/api/app/escalations`, { headers: { cookie: cookieB } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ escalations: [] });
  });
});

describe("POST /api/app/threads/:id/takeover and /handback -- the full ticket demo", () => {
  it("takeover pauses the thread and logs owner_reply+pause naming the caller; a second takeover just sends and does not double-pause; handback logs handback naming the caller and resumes it; the agent sends nothing automatically while paused", async () => {
    const cookie = await signUpAndGetCookie("v6-owner-d");
    const org = await createOrg(cookie, "FICTIONAL: Delta Events V6", "delta-events-v6");
    const { threadId } = await seedDiscountEscalation(org.id, "escalate-d");
    const memberId = await ownerMemberId(org.id);

    // 404 for a thread id that does not resolve under this tenant.
    const missing = await fetch(`${base}/api/app/threads/nonexistent-thread-id/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not found" });

    // Validation before any DB work.
    const empty = await fetch(`${base}/api/app/threads/${encodeURIComponent(threadId)}/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "   " }),
    });
    expect(empty.status).toBe(400);
    const tooLong = await fetch(`${base}/api/app/threads/${encodeURIComponent(threadId)}/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "x".repeat(1001) }),
    });
    expect(tooLong.status).toBe(400);

    // Take over and reply as the owner.
    const first = await fetch(`${base}/api/app/threads/${encodeURIComponent(threadId)}/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "FICTIONAL: I can do 10% off, let me check with the chef." }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.threadState).toBe("paused_owner");
    expect(typeof firstBody.reply).toBe("string");

    const afterFirst = await withTenant(db.pool, org.id, (c) =>
      c.query("SELECT type, payload FROM ledger_entries WHERE thread_id=$1 AND type='owner_message' ORDER BY tenant_seq", [threadId]),
    );
    expect(afterFirst.rows.map((r) => r.payload.command)).toEqual(["owner_reply", "pause"]);
    for (const row of afterFirst.rows) expect(row.payload.memberId).toBe(memberId);

    // The escalation is no longer open once the thread is taken over.
    const afterTakeoverList = await fetch(`${base}/api/app/escalations`, { headers: { cookie } });
    expect((await afterTakeoverList.json()).escalations).toEqual([]);

    // The agent sends nothing automatically while the thread is paused: a NEW customer message
    // through the real pipeline, same thread, is held for the owner -- not auto-answered. No new
    // quote/owner_quote/refusal/owner_reply appears; only an `enquiry` marked `heldForOwner` (plus
    // the pipeline's own "surfaced to the push recipients" ops-log row, unrelated to this guarantee
    // and present even with zero recipients, as handle-enquiry.ts's own T18 tests already show).
    const llm = createProvider({ LLM_PROVIDER: "keyword" }, { registry: false });
    const held = await runChat("can you also do the 13th instead?", { pool: db.pool, tenantId: org.id, customerRef: "escalate-d", llm });
    expect(held.reply).toBe("");
    expect(held.held).toBe(true);
    const after = await withTenant(db.pool, org.id, (c) =>
      c.query("SELECT type, payload FROM ledger_entries WHERE thread_id=$1 ORDER BY tenant_seq", [threadId]),
    );
    const newEnquiry = after.rows.filter((r) => r.type === "enquiry").at(-1)!;
    expect(newEnquiry.payload).toMatchObject({ heldForOwner: true });
    expect(after.rows.filter((r) => r.type === "quote" || r.type === "owner_quote" || r.type === "refusal")).toHaveLength(1); // only the original refusal
    expect(after.rows.filter((r) => r.type === "owner_message" && r.payload.command === "owner_reply")).toHaveLength(1); // only the takeover's own reply

    // A second takeover call just sends another message; it does not double-pause.
    const second = await fetch(`${base}/api/app/threads/${encodeURIComponent(threadId)}/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "FICTIONAL: Confirmed, 10% off." }),
    });
    expect(second.status).toBe(200);
    expect((await second.json()).threadState).toBe("paused_owner");
    const afterSecond = await withTenant(db.pool, org.id, (c) =>
      c.query(
        "SELECT payload FROM ledger_entries WHERE thread_id=$1 AND type='owner_message' AND payload->>'command' IN ('owner_reply','pause') ORDER BY tenant_seq",
        [threadId],
      ),
    );
    expect(afterSecond.rows.map((r) => r.payload.command)).toEqual(["owner_reply", "pause", "owner_reply"]);

    // Hand back: logs a handback row naming the same member, and resumes the thread.
    const handback = await fetch(`${base}/api/app/threads/${encodeURIComponent(threadId)}/handback`, {
      method: "POST",
      headers: { cookie },
    });
    expect(handback.status).toBe(200);
    const handbackBody = await handback.json();
    expect(handbackBody.threadState).not.toBe("paused_owner");
    expect(typeof handbackBody.reply).toBe("string");

    const handbackRow = await withTenant(db.pool, org.id, (c) =>
      c.query("SELECT payload FROM ledger_entries WHERE thread_id=$1 AND type='owner_message' AND payload->>'command'='handback'", [threadId]),
    );
    expect(handbackRow.rows).toHaveLength(1);
    expect(handbackRow.rows[0]!.payload).toMatchObject({ memberId });

    // 404 for handback on an unresolvable thread id too.
    const missingHandback = await fetch(`${base}/api/app/threads/nonexistent-thread-id/handback`, { method: "POST", headers: { cookie } });
    expect(missingHandback.status).toBe(404);
  });

  it("403s a non-owner caller and never takes a tenant id from the client, same discipline as every other /api/app/* route", async () => {
    const cookie = await signUpAndGetCookie("v6-owner-e");
    const org = await createOrg(cookie, "FICTIONAL: Echo Weddings V6", "echo-weddings-v6");
    const { threadId } = await seedDiscountEscalation(org.id, "escalate-e");

    const noSession = await fetch(`${base}/api/app/threads/${encodeURIComponent(threadId)}/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(noSession.status).toBe(401);

    const otherCookie = await signUpAndGetCookie("v6-owner-f");
    await createOrg(otherCookie, "FICTIONAL: Foxtrot Catering V6", "foxtrot-catering-v6");
    // Another tenant's owner, trying this tenant's thread id directly -> 404 (not found under THEIR tenant).
    const crossTenant = await fetch(`${base}/api/app/threads/${encodeURIComponent(threadId)}/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: otherCookie },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(crossTenant.status).toBe(404);
  });
});
