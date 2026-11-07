/** T18: owner takeover and handback. All data FICTIONAL. Seams: handleOwnerMessage, handleMessage, runDueTimers (injected clock), proofForThread. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { collectingNotifier } from "../escalation/index.js";
import type { LlmProvider } from "../llm/types.js";
import { handleMessage } from "../pipeline/handle-message.js";
import { paidEvent, seedTenant, TEST_SECRET } from "../payments/test-helpers.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { runDueTimers } from "../timers/run.js";
import { razorpaySim } from "../payments/razorpay-sim.js";
import { handleWebhook } from "../payments/webhook.js";
import { proofForThread } from "../payments/proof.js";
import { handleOwnerMessage } from "./handle.js";
import { seedOwnerMembers } from "./seed.js";
import { collectingOutbox, type OwnerOutgoing } from "./types.js";

let db: TestDb;
let kernel: KernelBridge;
let card: unknown;
const T = { id: "tenant-takeover", name: "FICTIONAL: Takeover Banquets" };
const OWNER = "+91 00000 50001", MANAGER = "+91 00000 50002", STAFF = "+91 00000 50003";
const T0 = "2026-11-07T10:00:00Z";
const GOOD = { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9200, intent: "enquiry" };
const META = { modelId: "test-model-1", provider: "testprov", region: "eu-test-1", usage: { tokens: 5, costMinor: 0 } };
let extractCalls = 0;
const llm: LlmProvider = {
  extract: () => {
    extractCalls++;
    return Promise.resolve({ ...META, fields: GOOD });
  },
  wordReply: (i) => Promise.resolve({ ...META, text: i.template }),
};
const outbox: OwnerOutgoing[] = [];
let n = 0;

beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
  card = await seedTenant(db.pool, kernel, T);
  await seedOwnerMembers(db.pool, T.id, [{ role: "owner", phone: OWNER }, { role: "manager", phone: MANAGER }, { role: "staff", phone: STAFF }]);
});
afterAll(async () => {
  await db.drop();
});

const at = (hoursAfterT0: number) => new Date(Date.parse(T0) + hoursAfterT0 * 3_600_000).toISOString().replace(".000Z", "Z");
const deps = () => ({ pool: db.pool, kernel, notifier: collectingNotifier([]), llm, ownerOutbox: collectingOutbox(outbox) });
const customer = (thread: string, message: string, now = T0) =>
  handleMessage(deps(), { tenant: T, threadId: thread, customerRef: `cust-${thread}`, rateCard: card, now, availability: { blockedDates: [] }, message });
const owner = (from: string, text: string, now = T0) => handleOwnerMessage({ pool: db.pool, kernel }, { tenant: T, senderRef: from, text, now });
const rows = async (sql: string, args: unknown[] = []) => (await withTenant(db.pool, T.id, (c) => c.query(sql, args))).rows;
const state = async (thread: string) => (await rows("SELECT state FROM threads WHERE id=$1", [thread]))[0]?.state as string;
const ledger = (thread: string, type?: string) =>
  rows(`SELECT type, payload, at FROM ledger_entries WHERE thread_id=$1 ${type ? "AND type=$2" : ""} ORDER BY tenant_seq`, type ? [thread, type] : [thread]);
const cmds = async (thread: string) => (await ledger(thread, "owner_message")).map((r) => r.payload.command as string);
const refFor = async (thread: string) => `Q${(await rows("SELECT tenant_seq::int AS s FROM ledger_entries WHERE thread_id=$1 AND type='quote' ORDER BY tenant_seq DESC LIMIT 1", [thread]))[0].s}`;
/** A thread the agent quoted (so Q<n> exists). */
async function quoted(): Promise<{ thread: string; ref: string }> {
  const thread = `to-${++n}`;
  await customer(thread, "hello");
  const q = (await rows("SELECT tenant_seq::int AS s FROM ledger_entries WHERE thread_id=$1 AND type='quote'", [thread]))[0];
  return { thread, ref: `Q${q.s}` };
}

describe("takeover", () => {
  it("an owner reply goes to the customer verbatim and pauses the agent; the customer's follow-up gets no reply, is stored and is surfaced to the owner", async () => {
    const { thread, ref } = await quoted();
    const r = await owner(OWNER, `reply ${ref} Hello, this is the owner. I will call you tonight.`);
    expect(r.customerMessages).toEqual([{ threadId: thread, text: "Hello, this is the owner. I will call you tonight." }]);
    expect(await state(thread)).toBe("paused_owner");
    expect(await cmds(thread)).toEqual(["owner_reply", "pause"]);

    const before = extractCalls;
    outbox.length = 0;
    const res = await customer(thread, "Can you do the 13th instead?", at(1));
    expect(res.reply).toBe("");
    expect(extractCalls).toBe(before);
    expect(await state(thread)).toBe("paused_owner");
    const stored = (await ledger(thread, "enquiry")).at(-1)!;
    expect(stored.payload).toMatchObject({ text: "Can you do the 13th instead?", heldForOwner: true });
    expect((await ledger(thread, "quote")).length).toBe(1);
    const surfaced = outbox.filter((m) => m.kind === "customer_message");
    expect(surfaced.map((m) => m.role).sort()).toEqual(["manager", "owner"]);
    expect(surfaced[0]!.text).toContain("Can you do the 13th instead?");
    expect(surfaced[0]!.text).toContain(ref);
  });
});

describe("explicit handback", () => {
  it("handback returns the thread to the agent, which answers the customer's next message; the ledger says who and when", async () => {
    const { thread, ref } = await quoted();
    await owner(OWNER, `reply ${ref} Let me check with the chef.`, at(0));
    await customer(thread, "any update?", at(1));
    const h = await owner(MANAGER, `handback ${ref}`, at(2));
    expect(h.reply).toContain("1 customer message");
    expect(await state(thread)).toBe("quoted");
    const row = (await ledger(thread, "owner_message")).filter((r) => r.payload.command === "handback");
    expect(row).toHaveLength(1);
    expect(row[0]!.payload).toMatchObject({ by: "owner", role: "manager", ref, resumedTo: "quoted", heldMessages: 1 });
    expect(new Date(row[0]!.at).getTime()).toBe(Date.parse(at(2)));

    const res = await customer(thread, "so what is the price again?", at(3));
    expect(res.reply).toContain("Total");
    expect(res.held).toBeUndefined();
  });

  it("handback with no ref applies to the only paused thread, says so when nothing is paused, and asks when several are", async () => {
    for (const t of await rows("SELECT id FROM threads WHERE state='paused_owner'")) await owner(OWNER, `handback ${await refFor(t.id as string)}`);
    expect((await owner(OWNER, "handback", at(0))).reply).toBe("Nothing is paused.");
    const a = await quoted(), b = await quoted();
    await owner(OWNER, `reply ${a.ref} hi`);
    expect((await owner(OWNER, "handback")).reply).toContain(`Handed ${a.ref} back`);
    await owner(OWNER, `reply ${a.ref} hi again`);
    await owner(OWNER, `reply ${b.ref} hello`);
    const ask = await owner(OWNER, "handback");
    expect(ask.reply).toContain("More than one");
    expect(await state(a.thread)).toBe("paused_owner");
    expect(await state(b.thread)).toBe("paused_owner");
  });

  it("a second handback does nothing (and a timer scheduled before the handback no longer fires a resume)", async () => {
    const { thread, ref } = await quoted();
    await owner(OWNER, `reply ${ref} hi`);
    await owner(OWNER, `handback ${ref}`);
    const again = await owner(OWNER, `handback ${ref}`);
    expect(again.reply).toContain("not paused");
    expect((await cmds(thread)).filter((c) => c === "handback")).toHaveLength(1);
    await runDueTimers(db.pool, at(48), { kernel });
    expect((await cmds(thread)).filter((c) => c === "idle_resume")).toHaveLength(0);
  });
});

describe("owner-sent prices are non-billable (T15 proof)", () => {
  const provider = razorpaySim({ webhookSecret: TEST_SECRET });
  /** Agent quotes with a payment link; the owner then speaks; the customer pays the agent's link via the signed webhook. */
  async function paidAfter(ownerText: string | undefined) {
    const thread = `to-${++n}`;
    const res = await handleMessage({ ...deps(), payments: provider }, { tenant: T, threadId: thread, customerRef: `cust-${thread}`, rateCard: card, now: T0, availability: { blockedDates: [] }, message: "hello" });
    if (res.outcome.kind !== "quote") throw new Error("expected quote");
    const ref = await refFor(thread);
    if (ownerText) await owner(OWNER, `reply ${ref} ${ownerText}`, at(1));
    const linkId = (await rows("SELECT provider_link_id FROM payments WHERE thread_id=$1", [thread]))[0].provider_link_id as string;
    const ev = paidEvent({ linkId, tenantId: T.id, amount: res.outcome.total, eventId: `evt_to_${thread}`, paymentId: `pay_to_${thread}` });
    await handleWebhook({ pool: db.pool, kernel, payments: provider }, ev.body, ev.headers, at(2));
    return { thread, proof: await proofForThread(db.pool, kernel, { tenantId: T.id, threadId: thread }) };
  }

  it("a price in the owner's message makes the paid job non-billable, and the proof says why", async () => {
    const { proof } = await paidAfter("I can do it for Rs 70,000 all in.");
    expect(proof).toMatchObject({ billable: "no", reason: "owner_priced", chainVerified: true });
    expect(proof.why).toContain("owner");
    expect(proof.chain.some((e) => e.type === "collected")).toBe(true);
  });

  it("an owner message with no price in it leaves the agent's price billable", async () => {
    const { proof } = await paidAfter("Happy to help, I will call you tonight.");
    expect(proof).toMatchObject({ billable: "yes", reason: "ok" });
  });

  it("an owner who never spoke: still billable (control)", async () => {
    expect((await paidAfter(undefined)).proof).toMatchObject({ billable: "yes" });
  });
});

describe("12h idle resume (durable timer, injected clock)", () => {
  it("resumes exactly 12 hours after the owner's last message, not before; then the agent answers; the ledger says it was the timer", async () => {
    const { thread, ref } = await quoted();
    await owner(OWNER, `reply ${ref} One moment please.`, at(0));
    await customer(thread, "hello?", at(5));
    expect((await runDueTimers(db.pool, at(11.99), { kernel })).resumedThreads).toEqual([]);
    expect(await state(thread)).toBe("paused_owner");
    expect((await customer(thread, "still there?", at(11.99))).reply).toBe("");

    const tick = await runDueTimers(db.pool, at(12), { kernel });
    expect(tick.resumedThreads).toEqual([thread]);
    expect(await state(thread)).toBe("quoted");
    const resume = (await ledger(thread, "owner_message")).filter((r) => r.payload.command === "idle_resume");
    expect(resume).toHaveLength(1);
    expect(resume[0]!.payload).toMatchObject({ by: { system: "timer" }, idleHours: 12, lastOwnerMessageAt: at(0).replace("Z", ".000Z"), resumedTo: "quoted", heldMessages: 2 });
    expect(new Date(resume[0]!.at).getTime()).toBe(Date.parse(at(12)));

    expect((await customer(thread, "price please", at(13))).reply).toContain("Total");
    expect((await runDueTimers(db.pool, at(30), { kernel })).resumedThreads).toEqual([]);
    expect((await cmds(thread)).filter((c) => c === "idle_resume")).toHaveLength(1);
  });

  it("each owner message restarts the 12 hours", async () => {
    const { thread, ref } = await quoted();
    await owner(OWNER, `reply ${ref} first`, at(0));
    await owner(MANAGER, `reply ${ref} second`, at(8));
    expect((await runDueTimers(db.pool, at(12), { kernel })).resumedThreads).toEqual([]);
    expect(await state(thread)).toBe("paused_owner");
    expect((await runDueTimers(db.pool, at(20), { kernel })).resumedThreads).toEqual([thread]);
    expect((await cmds(thread)).filter((c) => c === "pause")).toHaveLength(1);
  });

  it("the timer is a durable row, not process memory: it is in Postgres with the due time", async () => {
    const { thread, ref } = await quoted();
    await owner(OWNER, `reply ${ref} hi`, at(0));
    const t = (await db.pool.query("SELECT kind, run_at, status FROM timers WHERE subject_id=$1", [thread])).rows[0];
    expect(t).toMatchObject({ kind: "owner_idle_resume", status: "pending" });
    expect(new Date(t.run_at as string).getTime()).toBe(Date.parse(at(12)));
    await runDueTimers(db.pool, at(12), { kernel });
  });
});
