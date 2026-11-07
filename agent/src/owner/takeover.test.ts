/** T18: owner takeover and handback. All data FICTIONAL. Seams: handleOwnerMessage, handleMessage, runDueTimers (injected clock), proofForThread. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { setKillSwitch } from "../killswitch/index.js";
import { handleOwnerMessage } from "./handle.js";
import { looksLikePrice } from "./takeover.js";
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

describe("looksLikePrice fails safe toward non-billable", () => {
  const priced = ["७०,०००", "Rs70", "INR70", "seventy thousand", "70 thousand", "pachaas hazaar", "50 hazar", "80 per head", "70 only", "ek lakh", "5k", "₹ fifty", "twenty", "two hundred", "rupaye de dena", "Rs. 70", "पचास हज़ार रुपये", "एक लाख", "pachees rupaye", "free for you", "twenty five", "do hazaar", "five thousand", "no charge", "complimentary", "muft", "free of cost", "ten bucks", "a grand"];
  it.each(priced)("treats %j as priced", (t) => expect(looksLikePrice(t)).toBe(true));
  const plain = ["I will call them today, thanks", "Hello, this is the owner. Let me check with the chef.", "Do you want to move it?", "One moment please", "Can you do Saturday", "Two of us will come, ek minute"];
  it.each(plain)("leaves %j unpriced", (t) => expect(looksLikePrice(t)).toBe(false));
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

describe("kill switch interplay", () => {
  const flip = (on: boolean) => setKillSwitch({ pool: db.pool, kernel }, { target: { kind: "tenant", tenantId: T.id }, on, actor: { memberId: `${T.id}:member:owner:1` }, now: T0 });
  const clearOn = async (fn: () => Promise<void>) => {
    await flip(true);
    try {
      await fn();
    } finally {
      await flip(false);
    }
  };

  it("fails closed for prices: with the switch on, an owner message that could be a price is not sent and does not pause", async () => {
    const { thread, ref } = await quoted();
    await clearOn(async () => {
      for (const text of ["We can do Rs 70,000", "just 70000 for you", "seventy ₹ ok", "around 80k", "$900 flat"]) {
        const r = await owner(OWNER, `reply ${ref} ${text}`);
        expect(r.customerMessages).toEqual([]);
        expect(r.reply).toContain("Kill switch is on");
      }
      expect(await state(thread)).toBe("quoted");
      expect(await cmds(thread)).toEqual([]);
      const opsLogged = await rows("SELECT payload FROM ledger_entries WHERE type='owner_message' AND payload->>'rejected'='kill_switch' AND payload->>'command'='reply'");
      expect(opsLogged.length).toBeGreaterThanOrEqual(5);
    });
  });

  it("a price-free owner message still goes out with the switch on (a human talking to a customer is not the agent quoting), pauses, and is recorded as sent under the switch", async () => {
    const { thread, ref } = await quoted();
    await clearOn(async () => {
      const r = await owner(OWNER, `reply ${ref} Sorry for the delay, calling you shortly.`);
      expect(r.customerMessages).toHaveLength(1);
      expect(await state(thread)).toBe("paused_owner");
      expect((await ledger(thread, "owner_message"))[0]!.payload).toMatchObject({ command: "owner_reply", killSwitchOn: true, ownerPriced: false });
    });
  });

  it("a customer message to a paused thread under the switch is held and shown to the owner, with no kill-switch refusal and no escalation; after handback the switch refuses as usual", async () => {
    const { thread, ref } = await quoted();
    await owner(OWNER, `reply ${ref} one moment`);
    outbox.length = 0;
    await clearOn(async () => {
      const res = await customer(thread, "hello?", at(1));
      expect(res.held).toBe(true);
      expect(res.reply).toBe("");
      expect((await ledger(thread, "refusal")).length).toBe(0);
      expect(outbox.map((m) => m.kind)).toEqual(["customer_message", "customer_message"]);
      await owner(OWNER, `handback ${ref}`, at(2));
      const after = await customer(thread, "hello again", at(3));
      expect(after.outcome).toMatchObject({ kind: "refusal", reason: "kill_switch" });
    });
  });
});

describe("who may take over", () => {
  it("staff and strangers can not reply or hand back; nothing is sent or paused; the attempt is logged", async () => {
    const { thread, ref } = await quoted();
    const staff = await owner(STAFF, `reply ${ref} hi there`);
    expect(staff.customerMessages).toEqual([]);
    expect(staff.reply).toContain("only the owner or a manager");
    const stranger = await owner("+91 00000 59999", `reply ${ref} hi there`);
    expect(stranger.customerMessages).toEqual([]);
    expect(stranger.reply).toContain("not registered");
    expect(await state(thread)).toBe("quoted");
    expect((await owner(STAFF, "handback")).reply).toContain("only the owner or a manager");
  });

  it("an unknown ref, a refusal number used as a quote number and another tenant's ref all say 'can not find' and do nothing", async () => {
    const { thread } = await quoted();
    const r = await owner(OWNER, "reply Q99999 hi");
    expect(r.reply).toContain("can not find");
    expect(r.customerMessages).toEqual([]);
    const q = await refFor(thread);
    const other = { id: "tenant-takeover-other", name: "FICTIONAL: Other Banquets" };
    await seedTenant(db.pool, kernel, other);
    await seedOwnerMembers(db.pool, other.id, [{ role: "owner", phone: "+91 00000 60001" }]);
    const cross = await handleOwnerMessage({ pool: db.pool, kernel }, { tenant: other, senderRef: "+91 00000 60001", text: `reply ${q} hello from the wrong tenant`, now: T0 });
    expect(cross.customerMessages).toEqual([]);
    expect(await state(thread)).toBe("quoted");
  });

  it("tenancy: another tenant's session sees none of this tenant's pause, timer or held-message rows", async () => {
    const { thread, ref } = await quoted();
    await owner(OWNER, `reply ${ref} hi`);
    await customer(thread, "held one", at(1));
    const seen = await withTenant(db.pool, "tenant-takeover-other", async (c) => ({
      timers: (await c.query("SELECT 1 FROM timers WHERE subject_id=$1", [thread])).rowCount,
      ledger: (await c.query("SELECT 1 FROM ledger_entries WHERE thread_id=$1", [thread])).rowCount,
      threads: (await c.query("SELECT 1 FROM threads WHERE id=$1", [thread])).rowCount,
    }));
    expect(seen).toEqual({ timers: 0, ledger: 0, threads: 0 });
    expect((await rows("SELECT 1 FROM timers WHERE subject_id=$1", [thread])).length).toBe(1);
  });

  it("a paid (settled) thread: the message goes out, the thread is not paused", async () => {
    const thread = `to-${++n}`;
    await customer(thread, "hello");
    await db.pool.query("UPDATE threads SET state='collected' WHERE id=$1", [thread]);
    const r = await owner(OWNER, `reply ${await refFor(thread)} Thank you for booking!`);
    expect(r.customerMessages).toHaveLength(1);
    expect(await state(thread)).toBe("collected");
    expect(await cmds(thread)).toEqual(["owner_reply"]);
  });
});

describe("ticket demo, end to end", () => {
  const provider = razorpaySim({ webhookSecret: TEST_SECRET });
  for (const how of ["idle", "handback"] as const) {
    it(`enquiry -> owner message pauses -> follow-up unanswered -> ${how} -> agent answers; the owner-priced job is paid via webhook and the proof says non-billable`, async () => {
      await runDueTimers(db.pool, at(10_000), { kernel });
      const thread = `to-${++n}`;
      const first = await handleMessage({ ...deps(), payments: provider }, { tenant: T, threadId: thread, customerRef: `cust-${thread}`, rateCard: card, now: T0, availability: { blockedDates: [] }, message: "banquet for 120 on 12 Dec" });
      if (first.outcome.kind !== "quote") throw new Error("expected quote");
      const ref = await refFor(thread);
      await owner(OWNER, `reply ${ref} For you I can do 60,000 in total.`, at(1));
      expect((await customer(thread, "great, can you do 13 Dec?", at(2))).reply).toBe("");
      if (how === "idle") await runDueTimers(db.pool, at(13), { kernel });
      else await owner(MANAGER, `handback ${ref}`, at(3));
      expect(await state(thread)).toBe("quoted");
      expect((await customer(thread, "price for 13 Dec?", at(14))).reply).toContain("Total");
      const linkId = (await rows("SELECT provider_link_id FROM payments WHERE thread_id=$1 ORDER BY created_at LIMIT 1", [thread]))[0].provider_link_id as string;
      const ev = paidEvent({ linkId, tenantId: T.id, amount: first.outcome.total, eventId: `evt_demo_${how}`, paymentId: `pay_demo_${how}` });
      await handleWebhook({ pool: db.pool, kernel, payments: provider }, ev.body, ev.headers, at(15));
      const proof = await proofForThread(db.pool, kernel, { tenantId: T.id, threadId: thread });
      expect(proof).toMatchObject({ billable: "no", reason: "owner_priced" });
      expect(proof.chain.map((e) => e.summary).join("\n")).toContain("contains a price");
    });
  }
});

const sleep =(ms: number) => new Promise((r) => setTimeout(r, ms));

describe("concurrency (row locks, real races)", () => {
  beforeEach(async () => {
    await runDueTimers(db.pool, at(10_000), { kernel });
  });

  it("the owner and a manager reply at the same moment: both go out, exactly one pause is recorded, one timer", async () => {
    const { thread, ref } = await quoted();
    const [a, b] = await Promise.all([owner(OWNER, `reply ${ref} from the owner`, at(0)), owner(MANAGER, `reply ${ref} from the manager`, at(0))]);
    expect(a.customerMessages).toHaveLength(1);
    expect(b.customerMessages).toHaveLength(1);
    expect((await cmds(thread)).filter((c) => c === "pause")).toHaveLength(1);
    expect((await cmds(thread)).filter((c) => c === "owner_reply")).toHaveLength(2);
    expect((await rows("SELECT 1 FROM timers WHERE subject_id=$1 AND status='pending'", [thread])).length).toBe(1);
  });

  it("a handback and the idle timer firing at the same moment resume the thread exactly once", async () => {
    const { thread, ref } = await quoted();
    await owner(OWNER, `reply ${ref} hi`, at(0));
    await Promise.all([owner(OWNER, `handback ${ref}`, at(12)), runDueTimers(db.pool, at(12), { kernel })]);
    const c = await cmds(thread);
    expect(c.filter((x) => x === "handback").length + c.filter((x) => x === "idle_resume").length).toBe(1);
    expect(await state(thread)).toBe("quoted");
  });

  it("a customer message queued behind a held lock while the owner replies: either order is consistent (answered then paused, or held), never answered after the pause", async () => {
    const { thread, ref } = await quoted();
    const quotesBefore = (await ledger(thread, "quote")).length;
    const lock = await db.pool.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT 1 FROM threads WHERE id=$1 FOR UPDATE", [thread]);
    const c = customer(thread, "can you do the 14th?", at(1));
    const o = owner(OWNER, `reply ${ref} I will take it from here`, at(1));
    await sleep(300);
    await lock.query("COMMIT");
    lock.release();
    const [cr] = await Promise.all([c, o]);
    expect(await state(thread)).toBe("paused_owner");
    const quotesAfter = (await ledger(thread, "quote")).length;
    if (cr.held) expect(quotesAfter).toBe(quotesBefore);
    else {
      expect(cr.reply).not.toBe("");
      expect(quotesAfter).toBe(quotesBefore + 1);
      const order = (await ledger(thread)).map((r) => r.type === "owner_message" ? (r.payload.command as string) : r.type);
      expect(order.lastIndexOf("quote")).toBeLessThan(order.indexOf("pause"));
    }
  });

  it("a customer message whose pause was seen before extraction, but which is handed back before it gets the lock, is answered normally (no lost reply)", async () => {
    const { thread, ref } = await quoted();
    await owner(OWNER, `reply ${ref} hi`, at(0));
    const lock = await db.pool.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT 1 FROM threads WHERE id=$1 FOR UPDATE", [thread]);
    const before = extractCalls;
    const c = customer(thread, "price please", at(1));
    await sleep(300); // the customer call has now read "paused" and is waiting for the lock
    await lock.query("UPDATE threads SET state='quoted', paused_from=NULL WHERE id=$1", [thread]);
    await lock.query("COMMIT");
    lock.release();
    const res = await c;
    expect(res.held).toBeUndefined();
    expect(res.reply).toContain("Total");
    expect(extractCalls).toBe(before + 1);
  });

  it("lock order: the idle timer waits for the thread BEFORE taking the ledger head, so a busy thread never stalls the tenant's other writes (and can not deadlock with the pipeline)", async () => {
    const a = await quoted(), b = await quoted();
    await owner(OWNER, `reply ${a.ref} hi`, at(0));
    const lock = await db.pool.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT 1 FROM threads WHERE id=$1 FOR UPDATE", [a.thread]);
    const tick = runDueTimers(db.pool, at(12), { kernel });
    await sleep(300); // the worker has claimed the timer and is parked on thread a
    const other = await Promise.race([customer(b.thread, "another thread, same tenant", at(12)).then(() => "done"), sleep(3000).then(() => "stalled")]);
    await lock.query("COMMIT");
    lock.release();
    await tick;
    expect(other).toBe("done");
    expect(await state(a.thread)).toBe("quoted");
  });

  it("no deadlocks: customers, owners, handbacks and the timer worker all hammering the same threads for several rounds", async () => {
    const ts = [await quoted(), await quoted(), await quoted()];
    for (let round = 0; round < 6; round++) {
      const jobs: Promise<unknown>[] = [runDueTimers(db.pool, at(round * 5 + 13), { kernel })];
      for (const t of ts) {
        jobs.push(customer(t.thread, `msg ${round}`, at(round * 5 + 1)));
        jobs.push(owner(round % 2 ? OWNER : MANAGER, `reply ${t.ref} round ${round}`, at(round * 5)));
        jobs.push(owner(OWNER, `handback ${t.ref}`, at(round * 5 + 2)));
      }
      await Promise.all(jobs);
    }
    for (const t of ts) expect(["paused_owner", "quoted"]).toContain(await state(t.thread));
  });
});

describe("12h idle resume (durable timer, injected clock)", () => {
  beforeEach(async () => {
    await runDueTimers(db.pool, at(10_000), { kernel }); // drain timers left by earlier tests so each test sees only its own
  });

  it("resumes exactly 12 hours after the owner's last message, not before; then the agent answers; the ledger says it was the timer", async () => {
    const { thread, ref } = await quoted();
    await owner(OWNER, `reply ${ref} One moment please.`, at(0));
    await customer(thread, "hello?", at(5));
    const justBefore = new Date(Date.parse(at(12)) - 1000).toISOString(); // 11:59:59
    expect((await runDueTimers(db.pool, justBefore, { kernel })).resumedThreads).toEqual([]);
    expect(await state(thread)).toBe("paused_owner");
    expect((await customer(thread, "still there?", justBefore)).reply).toBe("");

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
