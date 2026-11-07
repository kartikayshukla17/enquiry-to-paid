/** T17: roles, routing, refs, tenancy, why, digest and billing interplay at the public seams (handleOwnerMessage, routeInbound, buildDigest, SQL as e2p_app). FICTIONAL data; phones are +91 00000 xxxxx. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { proofForThread } from "../payments/proof.js";
import { razorpaySim } from "../payments/razorpay-sim.js";
import { handleWebhook } from "../payments/webhook.js";
import { ask, paidEvent, seedTenant, TEST_SECRET } from "../payments/test-helpers.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { buildDigest } from "./digest.js";
import { handleOwnerMessage } from "./handle.js";
import { routeInbound } from "./inbound.js";
import { createOwnerNotifier } from "./notifier.js";
import { seedOwnerMembers } from "./seed.js";
import { collectingOutbox, type OwnerOutgoing } from "./types.js";

let db: TestDb;
let kernel: KernelBridge;
beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

const A = { id: "tenant-own-a", name: "FICTIONAL: Owner Test A" };
const B = { id: "tenant-own-b", name: "FICTIONAL: Owner Test B" };
const OWNER_A = "+91 00000 10001", MANAGER_A = "+91 00000 10002", STAFF_A = "+91 00000 10003", STRANGER = "+91 00000 10099", OWNER_B = "+91 00000 20001";
const NOW = "2026-11-07T10:00:00Z";
const outbox: OwnerOutgoing[] = [];
let card: unknown;

/** A discount request is a typed refusal (`discount_request`) that escalates to the owner. */
async function refuse(t: typeof A, thread: string, date = "2026-12-12") {
  const notifier = createOwnerNotifier({ pool: db.pool, kernel, outbox: collectingOutbox(outbox) });
  return handleEnquiry(
    { pool: db.pool, kernel, notifier },
    { tenant: t, threadId: thread, customerRef: `cust-${thread}`, rateCard: card, now: NOW, availability: { blockedDates: [] }, message: "can you do it cheaper?",
      fields: { service: "banquet", date, guestCount: 120, language: "en", confidenceBps: 9000, intent: "discount_request" } },
  );
}
const say = (t: typeof A, from: string, text: string, now = NOW) => handleOwnerMessage({ pool: db.pool, kernel }, { tenant: t, senderRef: from, text, now });
const rows = async (t: typeof A, sql: string, args: unknown[] = []) => (await withTenant(db.pool, t.id, (c) => c.query(sql, args))).rows;
const count = async (t: typeof A, type: string) => (await rows(t, "SELECT count(*)::int AS n FROM ledger_entries WHERE type=$1", [type]))[0].n as number;
const refOfThread = async (t: typeof A, thread: string) => `R${(await rows(t, "SELECT tenant_seq::int AS n FROM ledger_entries WHERE thread_id=$1 AND type='refusal' ORDER BY tenant_seq DESC LIMIT 1", [thread]))[0].n}`;

beforeAll(async () => {
  card = await seedTenant(db.pool, kernel, A);
  await seedTenant(db.pool, kernel, B);
  await seedOwnerMembers(db.pool, A.id, [{ role: "owner", phone: OWNER_A }, { role: "manager", phone: MANAGER_A }, { role: "staff", phone: STAFF_A }]);
  await seedOwnerMembers(db.pool, B.id, [{ role: "owner", phone: OWNER_B }]);
});

describe("routing: owner messages are never customer enquiries", () => {
  it("a member's message, even one that reads like an enquiry, goes to the owner channel and creates no enquiry or customer thread", async () => {
    let customerCalls = 0;
    const before = { enq: await count(A, "enquiry"), threads: (await rows(A, "SELECT count(*)::int AS n FROM threads"))[0].n };
    for (const from of [OWNER_A, MANAGER_A, STAFF_A]) {
      const r = await routeInbound({ pool: db.pool, kernel }, { tenant: A, senderRef: from, text: "Hi, I need a banquet for 120 guests on 12 December 2026, quote please", now: NOW }, async () => {
        customerCalls += 1;
      });
      expect(r.channel).toBe("owner");
    }
    expect(customerCalls).toBe(0);
    expect(await count(A, "enquiry")).toBe(before.enq);
    expect((await rows(A, "SELECT count(*)::int AS n FROM threads"))[0].n).toBe(before.threads + 1); // only the tenant's operations thread
  });

  it("a stranger's 'quote 5000' is an ordinary customer message: it reaches the customer pipeline and prices nothing", async () => {
    const r = await routeInbound({ pool: db.pool, kernel }, { tenant: A, senderRef: STRANGER, text: "quote 5000", now: NOW }, async () => "customer pipeline");
    expect(r).toEqual({ channel: "customer", result: "customer pipeline" });
    expect(await count(A, "owner_quote")).toBe(0);
  });

  it("a member of another tenant is a stranger here", async () => {
    const r = await routeInbound({ pool: db.pool, kernel }, { tenant: A, senderRef: OWNER_B, text: "quote 5000", now: NOW }, async () => "customer");
    expect(r.channel).toBe("customer");
  });
});

describe("roles: only owner and manager set prices; staff read; strangers do nothing", () => {
  it("staff and strangers are refused every write command, nothing changes, each attempt is a ledger entry", async () => {
    await refuse(A, "own-role-1");
    const ref = await refOfThread(A, "own-role-1");
    const before = { oq: await count(A, "owner_quote"), state: (await rows(A, "SELECT state FROM threads WHERE id='own-role-1'"))[0].state };
    for (const [who, from] of [["staff", STAFF_A], ["stranger", STRANGER]] as const) {
      for (const text of [`quote ${ref} 5000`, `decline ${ref}`, `call them ${ref}`]) {
        const r = await say(A, from, text);
        expect(r.customerMessages).toEqual([]);
        expect(r.reply).toMatch(who === "staff" ? /^Sorry, only the owner or a manager/ : /^This number is not registered/);
        expect(r.ledgerRow?.payload).toMatchObject({ denied: true });
      }
    }
    expect(await count(A, "owner_quote")).toBe(before.oq);
    expect((await rows(A, "SELECT state FROM threads WHERE id='own-role-1'"))[0].state).toBe(before.state);
    expect((await rows(A, "SELECT 1 FROM ledger_entries WHERE type='owner_message' AND payload->>'command' IN ('decline','call_them') AND payload->>'denied' IS NULL")).length).toBe(0);
  });

  it("staff can read: digest and why work", async () => {
    const ref = await refOfThread(A, "own-role-1");
    expect((await say(A, STAFF_A, `why ${ref}`)).reply).toContain("Reason: Customer asked for a discount or special deal (discount_request).");
    expect((await say(A, STAFF_A, "digest")).reply).toMatch(/^Daily summary for FICTIONAL: Owner Test A/);
  });

  it("the owner's free text is never forwarded to the customer: a quote with extra words is a usage error", async () => {
    const ref = await refOfThread(A, "own-role-1");
    const r = await say(A, OWNER_A, `quote ${ref} 5000 and tell them they are cheapskates`);
    expect(r.customerMessages).toEqual([]);
    expect(r.reply).toMatch(/^Say it like: quote 85000/);
    expect(await count(A, "owner_quote")).toBe(0);
  });
});

describe("refs: never guess, never act twice, never cross a tenant", () => {
  it("with two enquiries waiting a bare command asks which; an explicit ref prices exactly that one; repeating it does nothing", async () => {
    await refuse(A, "own-ref-2", "2026-12-19");
    const r1 = await refOfThread(A, "own-role-1");
    const r2 = await refOfThread(A, "own-ref-2");
    const ask1 = await say(A, OWNER_A, "quote 5000");
    expect(ask1.reply).toContain("More than one enquiry is waiting");
    expect(ask1.reply).toContain(`${r1} (banquet, 12 Dec 2026, 120 guests;`);
    expect(ask1.reply).toContain(`${r2} (banquet, 19 Dec 2026, 120 guests;`);
    expect(await count(A, "owner_quote")).toBe(0);

    const done = await say(A, MANAGER_A, `quote ${r2} 1,20,000`);
    expect(done.reply).toBe(`Done. Sent the customer your price of ₹1,20,000 for ${r2}. This one is your price, so it is not billable.`);
    expect(done.customerMessages).toHaveLength(1);
    expect(done.customerMessages[0]).toMatchObject({ threadId: "own-ref-2" });
    expect(done.customerMessages[0]!.text).toContain("Total: ₹1,20,000");
    expect((await rows(A, "SELECT state FROM threads WHERE id='own-role-1'"))[0].state).toBe("refused");

    const again = await say(A, OWNER_A, `quote ${r2} 9999`);
    expect(again.reply).toContain(`${r2} is not waiting for you any more`);
    expect(again.customerMessages).toEqual([]);
    expect(await count(A, "owner_quote")).toBe(1);
    // now only r1 is waiting, so a bare 'decline' means r1
    const dec = await say(A, OWNER_A, "decline");
    expect(dec.reply).toBe(`Done. ${r1} was declined and the customer was told politely.`);
    expect((await say(A, OWNER_A, "decline")).reply).toBe("Nothing is waiting for you.");
  });

  it("another tenant's owner cannot act on this tenant's refs: nothing changes on either side", async () => {
    await refuse(A, "own-ten-3", "2026-12-26");
    const ref = await refOfThread(A, "own-ten-3");
    const beforeA = await count(A, "owner_quote");
    const r = await say(B, OWNER_B, `quote ${ref} 5000`); // B's channel, A's ref number
    expect(r.customerMessages).toEqual([]);
    expect(r.reply).toMatch(/^(Nothing is waiting for you|R\d+ is not waiting for you any more)/);
    expect(await count(A, "owner_quote")).toBe(beforeA);
    expect((await rows(A, "SELECT state FROM threads WHERE id='own-ten-3'"))[0].state).toBe("refused");
    expect((await say(A, OWNER_B, `quote ${ref} 5000`)).reply).toMatch(/^This number is not registered/); // B's owner on A's channel
  });

  it("RLS: tenant B, as e2p_app, cannot read tenant A's owner_quote or owner_message rows", async () => {
    expect(await count(A, "owner_quote")).toBeGreaterThan(0);
    expect((await rows(B, "SELECT 1 FROM ledger_entries WHERE tenant_id=$1 AND type IN ('owner_quote','owner_message')", [A.id])).length).toBe(0);
  });
});

describe("why: built from ledger rows only", () => {
  it("an agent quote lists its rules and total from the stored row; an owner price says it is not from the rate card; unknown refs are not invented", async () => {
    const res = await ask(db.pool, kernel, undefined, A, card, "own-why-q");
    if (res.outcome.kind !== "quote") throw new Error("expected a quote");
    const q = (await rows(A, "SELECT tenant_seq::int AS n, rate_card_hash FROM ledger_entries WHERE thread_id='own-why-q' AND type='quote'"))[0];
    const why = (await say(A, OWNER_A, `why Q${q.n}`)).reply.split("\n");
    expect(why[0]).toBe(`Q${q.n}: the agent quoted this from your rate card ${String(q.rate_card_hash).slice(0, 12)}.`);
    for (const l of res.outcome.lines) expect(why).toContain(`- ${l.label}: ₹${(l.amount / 100).toLocaleString("en-IN")} (rule ${l.ruleId})`);
    expect(why).toContain(`Total: ₹${(res.outcome.total / 100).toLocaleString("en-IN")}.`);

    const oq = (await rows(A, "SELECT tenant_seq::int AS n FROM ledger_entries WHERE type='owner_quote' ORDER BY tenant_seq LIMIT 1"))[0];
    const own = (await say(A, STAFF_A, `why Q${oq.n}`)).reply;
    expect(own).toContain("a price set by your manager, not by the agent.");
    expect(own).toContain("Total: ₹1,20,000. It did not come from your rate card, so no rule applies and the job is not billable.");

    expect((await say(A, OWNER_A, "why R99999")).reply).toBe("I can not find R99999 in your ledger.");
    expect((await say(A, OWNER_A, `why R${q.n}`)).reply).toBe(`I can not find R${q.n} in your ledger.`); // a quote's number is not a refusal's
    expect((await say(A, OWNER_B, `why R${q.n}`)).reply).toMatch(/^This number is not registered/);
    expect((await say(B, OWNER_B, `why Q${q.n}`)).reply).toBe(`I can not find Q${q.n} in your ledger.`); // another tenant's row
  });
});

describe("digest", () => {
  it("is deterministic for the same ledger and clock, counts only the 24h window, and keeps open work visible", async () => {
    const x = await buildDigest(db.pool, A, "2026-11-08T09:00:00Z");
    const y = await buildDigest(db.pool, A, "2026-11-08T09:00:00Z");
    expect(x).toEqual(y);
    expect(x.counts.enquiries).toBeGreaterThan(0);
    const later = await buildDigest(db.pool, A, "2026-11-12T09:00:00Z"); // 4 days on: nothing in the window
    expect(later.counts).toMatchObject({ enquiries: 0, agentQuotes: 0, ownerQuotes: 0, refusals: 0, collected: [] });
    expect(later.counts.awaitingOwner).toBe(x.counts.awaitingOwner); // still waiting, whatever the date
    expect(later.text).toContain("Waiting for you (1):");
  });

  it("counts a collected payment exactly once, in the tenant's currency", async () => {
    const provider = razorpaySim({ webhookSecret: TEST_SECRET });
    const res = await ask(db.pool, kernel, provider, B, card, "own-pay-1", "2026-11-07T10:30:00Z");
    if (res.outcome.kind !== "quote") throw new Error("expected a quote");
    const link = (await rows(B, "SELECT provider_link_id FROM payments WHERE thread_id='own-pay-1'"))[0].provider_link_id as string;
    const ev = paidEvent({ linkId: link, tenantId: B.id, amount: res.outcome.total });
    await handleWebhook({ pool: db.pool, kernel, payments: provider }, ev.body, ev.headers, "2026-11-07T10:31:00Z");
    const d = await buildDigest(db.pool, B, "2026-11-07T12:00:00Z");
    expect(d.counts.collected).toEqual([{ currency: "INR", count: 1, totalMinor: res.outcome.total }]);
    expect(d.counts.agentQuotes).toBe(1);
    expect(d.text).toContain(`- Collected: 1 payment, ₹${(res.outcome.total / 100).toLocaleString("en-IN")}`);
  });
});

describe("billing interplay (T15): an owner-priced job is never billable", () => {
  it("proof says owner_priced for a thread the owner priced, even though the agent refused it first", async () => {
    await refuse(A, "own-bill-1", "2027-01-02");
    const ref = await refOfThread(A, "own-bill-1");
    await say(A, OWNER_A, `quote ${ref} 75000`);
    const p = await proofForThread(db.pool, kernel, { tenantId: A.id, threadId: "own-bill-1" });
    expect(p).toMatchObject({ billable: "no", reason: "owner_priced", chainVerified: true });
    expect(p.chain.map((e) => e.type)).toContain("owner_quote");
  });
});

describe("escalation delivery", () => {
  it("goes to the owner then the manager, never staff, and carries the ref of the refusal row", async () => {
    const before = outbox.length;
    await refuse(A, "own-esc-1", "2027-01-09");
    const sent = outbox.slice(before);
    expect(sent.map((m) => m.role)).toEqual(["owner", "manager"]);
    expect(sent[0]!.text.startsWith(`[${await refOfThread(A, "own-esc-1")}] `)).toBe(true);
    expect(sent.some((m) => m.role === ("staff" as string))).toBe(false);
  });
});
