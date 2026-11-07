/**
 * T19: chasers with consent. All data FICTIONAL, no network. Seams: handleEnquiry / handleMessage (the customer side),
 * runDueTimers on the injected clock with a collecting chaser outbox (the send side), and the ledger as the record.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { collectingNotifier } from "../escalation/index.js";
import type { LlmProvider } from "../llm/types.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { handleMessage } from "../pipeline/handle-message.js";
import { seedApprovedCard } from "../ratecard/legacy.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { runDueTimers } from "../timers/run.js";
import { razorpaySim } from "../payments/razorpay-sim.js";
import { handleWebhook } from "../payments/webhook.js";
import { paidEvent, TEST_SECRET } from "../payments/test-helpers.js";
import { setKillSwitch } from "../killswitch/index.js";
import { handleOwnerMessage } from "../owner/handle.js";
import { seedOwnerMembers } from "../owner/seed.js";
import { nativeAvailability } from "../availability/native.js";
import { consentStatus, UNSUBSCRIBED_NOTICE } from "./index.js";
import { appendEntry, verifyLedger } from "../ledger/index.js";
import { APP_ROLE } from "../tenancy/with-tenant.js";
import { collectingChaserOutbox, type ChaserMessage } from "./index.js";

let db: TestDb;
let kernel: KernelBridge;
type Card = { id: string; holdHours: number; validDays: number };
let card: Card;
let holdCard: Card;
let shortCard: Card;
let midCard: Card;
const T = { id: "tenant-chasers", name: "FICTIONAL: Chaser Banquets" };
const T0 = "2026-11-07T10:00:00Z";
const GOOD = { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9200, intent: "enquiry" as const };
const META = { modelId: "test-model-1", provider: "testprov", region: "eu-test-1", usage: { tokens: 5, costMinor: 0 } };
let extractCalls = 0;
const llm: LlmProvider = {
  extract: () => {
    extractCalls++;
    return Promise.resolve({ ...META, fields: GOOD });
  },
  wordReply: (i) => Promise.resolve({ ...META, text: i.template }),
};
let n = 0;

beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
  // Cards differ only in how long a quote is valid (validDays) and how long a date is held (holdHours).
  const raw = JSON.parse(await readFile(fileURLToPath(new URL("../../../rate-cards/fictional-banquet.json", import.meta.url)), "utf8")) as Card;
  card = { ...raw, id: "fictional-banquet-30d", validDays: 30 };
  shortCard = { ...raw, id: "fictional-banquet-1d", validDays: 1 };
  midCard = { ...raw, id: "fictional-banquet-2d", validDays: 2 };
  holdCard = { ...raw, id: "fictional-banquet-hold12", validDays: 30, holdHours: 12 };
  await seedApprovedCard({ pool: db.pool, kernel }, { tenant: T, card, now: T0 });
  await seedApprovedCard({ pool: db.pool, kernel }, { tenant: T, card: shortCard, now: T0 });
  await seedApprovedCard({ pool: db.pool, kernel }, { tenant: T, card: midCard, now: T0 });
  await seedApprovedCard({ pool: db.pool, kernel }, { tenant: T, card: holdCard, now: T0 });
  await seedOwnerMembers(db.pool, T.id, [{ role: "owner", phone: "+91 00000 60001" }]);
});
afterAll(async () => {
  await db.drop();
});

const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString().replace(".000Z", "Z");
const sent: ChaserMessage[] = [];
const outbox = collectingChaserOutbox(sent);
const provider = razorpaySim({ webhookSecret: TEST_SECRET });
const deps = (extra: Record<string, unknown> = {}) => ({ pool: db.pool, kernel, notifier: collectingNotifier([]), llm, chasers: true as const, payments: provider, ...extra });
const ref = (thread: string) => `cust-${thread}`;
const base = (thread: string, message: string, now: string, rateCard: unknown = card) => ({ tenant: T, threadId: thread, customerRef: ref(thread), rateCard, now, availability: { blockedDates: [] }, message });
/** The agent quotes (typed fields, as the pipeline would hand them over). */
const quote = (thread: string, now = T0, o: { card?: unknown; fields?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) =>
  handleEnquiry(deps(o.extra), { ...base(thread, "quote?", now, o.card), fields: { ...GOOD, ...o.fields } });
const say = (thread: string, message: string, now = T0) => handleMessage(deps(), base(thread, message, now));
const tick = (now: string) => runDueTimers(db.pool, now, { kernel, chaserOutbox: outbox });
/** The shared database holds every test's threads, so assertions look at one thread's chasers. */
const sentBy = async (th: string, now: string) => (await tick(now)).chasersSent.filter((s) => s.threadId === th);
const rows = async (sql: string, args: unknown[] = []) => (await withTenant(db.pool, T.id, (c) => c.query(sql, args))).rows;
const ledger = (thread: string, type: string) => rows("SELECT payload, at FROM ledger_entries WHERE thread_id=$1 AND type=$2 ORDER BY tenant_seq", [thread, type]);
const thread = () => `ch-${++n}`;
const sentTo = (th: string) => sent.filter((m) => m.threadId === th);

describe("consent", () => {
  it("a quote reply carries the opt-in question when chasers are on, and says nothing about it when they are off", async () => {
    const on = await quote(thread());
    expect(on.reply).toContain("Reply YES");
    const off = await handleEnquiry({ pool: db.pool, kernel, notifier: collectingNotifier([]) }, { ...base(thread(), "quote?", T0), fields: { ...GOOD } });
    expect(off.reply).not.toContain("Reply YES");
  });

  it("'yes' to the opt-in question writes a consent entry with its source and timestamp, and the LLM never sees it", async () => {
    const th = thread();
    await quote(th);
    const calls = extractCalls;
    const r = await say(th, "Yes", at(1));
    expect(r.reply).toContain("at most two reminders");
    expect(extractCalls).toBe(calls);
    const granted = (await ledger(th, "consent")).filter((e) => e.payload.action === "granted");
    expect(granted).toHaveLength(1);
    expect(granted[0]!.payload).toMatchObject({ source: "whatsapp_optin_reply", customerId: `${T.id}:cust:${ref(th)}` });
    expect(new Date(granted[0]!.at).toISOString()).toBe("2026-11-07T11:00:00.000Z");
  });

  it("without a consent entry no chaser is ever sent, however long the thread waits", async () => {
    const th = thread();
    await quote(th);
    await tick(at(24));
    await tick(at(72));
    await tick(at(500));
    expect(sentTo(th)).toEqual([]);
    expect(await ledger(th, "chaser_sent")).toEqual([]);
    expect((await ledger(th, "chase")).map((e) => e.payload.reason)).toEqual(["no_consent"]);
  });
});

describe("a 'yes' is only an opt-in answer when it is one", () => {
  const flip = (on: boolean, now: string) => setKillSwitch({ pool: db.pool, kernel }, { target: { kind: "tenant", tenantId: T.id }, on, actor: { memberId: `${T.id}:member:owner:1` }, now });
  const grants = async (th: string) => (await ledger(th, "consent")).filter((e) => e.payload.action === "granted");

  it("on a thread paused for the owner a 'yes' is left to the takeover handling, and grants nothing", async () => {
    const th = thread();
    await quote(th);
    const seq = (await rows("SELECT tenant_seq::int AS s FROM ledger_entries WHERE thread_id=$1 AND type='quote'", [th]))[0].s as number;
    await handleOwnerMessage({ pool: db.pool, kernel }, { tenant: T, senderRef: "+91 00000 60001", text: `reply Q${seq} Hello, this is the owner.`, now: at(1) });
    const calls = extractCalls;
    const r = await say(th, "yes", at(2));
    expect(r.consent).toBeUndefined();
    expect(extractCalls).toBe(calls); // paused: no model either
    expect(await grants(th)).toEqual([]);
    expect((await consentStatus(db.pool, T.id, ref(th))).status).toBe("requested");
    expect(await ledger(th, "enquiry")).toHaveLength(2); // stored for the owner like any paused message
  });

  it("with the kill switch on a 'yes' is refused like any other message and grants nothing", async () => {
    const th = thread();
    await quote(th);
    await flip(true, at(1));
    try {
      const calls = extractCalls;
      const r = await say(th, "yes", at(2));
      expect(r.consent).toBeUndefined();
      expect(r.outcome).toMatchObject({ kind: "refusal", reason: "kill_switch" });
      expect(extractCalls).toBe(calls);
    } finally {
      await flip(false, at(3));
    }
    expect(await grants(th)).toEqual([]);
    expect((await consentStatus(db.pool, T.id, ref(th))).status).toBe("requested");
  });

  it.each(["ji", "ha", "जी", "Ji!"])("%j alone is not a yes (it is only polite noise)", async (text) => {
    const th = thread();
    await quote(th);
    const r = await say(th, text, at(1));
    expect(r.consent).toBeUndefined();
    expect(await grants(th)).toEqual([]);
  });

  it("a 'yes' counts only while the opt-in question was the last thing the agent said on the thread", async () => {
    const th = thread();
    await quote(th);
    await withTenant(db.pool, T.id, (c) => appendEntry(c, kernel, { tenantId: T.id, threadId: th, at: at(1), type: "refusal", payload: { kind: "refusal", reason: "out_of_policy" } })).then(() => undefined);
    expect((await say(th, "yes", at(2))).consent).toBeUndefined();
    expect(await grants(th)).toEqual([]);
    await say(th, "quote again please", at(3)); // a fresh quote carries the question again
    expect((await say(th, "yes", at(4))).consent).toBe("granted");
  });
});

/** A quoted thread whose customer opted in `optInAfterHours` after the quote. */
async function optedIn(optInAfterHours = 1, o: Parameters<typeof quote>[2] = {}): Promise<{ th: string; reply: string; total: number }> {
  const th = thread();
  const q = await quote(th, T0, o);
  if (q.outcome.kind !== "quote") throw new Error("expected a quote");
  await say(th, "yes", at(optInAfterHours));
  return { th, reply: q.reply, total: q.outcome.total };
}
const cancelReasons = async (th: string) => (await ledger(th, "chase")).map((e) => e.payload.reason as string);

describe("schedule: chaser 1, chaser 2, then stop", () => {
  it("sends nothing before the first is due, then chaser 1 as templated free text inside the 24h window, with kernel numbers only", async () => {
    const { th, reply } = await optedIn(1); // the customer's last message is the opt-in at +1h; the clock restarts from it
    await tick(at(24.99));
    expect(sentTo(th)).toEqual([]);
    expect(await sentBy(th, at(25))).toEqual([{ threadId: th, n: 1 }]);
    const [m] = sentTo(th);
    expect(m).toMatchObject({ n: 1, kind: "free_text", at: "2026-11-08T11:00:00Z", customerId: `${T.id}:cust:${ref(th)}` });
    expect(m!.template).toBeUndefined();
    expect(m!.params.business).toBe(T.name);
    expect(reply).toContain(m!.params.amount);
    expect(m!.text).toContain(m!.params.amount);
    expect(m!.text).toContain(T.name);
    expect(m!.text).toContain("Reply STOP");
    const entries = await ledger(th, "chaser_sent");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.payload).toMatchObject({ n: 1, kind: "free_text", text: m!.text });
  });

  it("chaser 2 at 72h goes out as an approved template message (outside the window), and there is never a third", async () => {
    const { th } = await optedIn(1);
    await tick(at(25));
    expect(await sentBy(th, at(72.99))).toEqual([]);
    expect(await sentBy(th, at(73))).toEqual([{ threadId: th, n: 2 }]);
    const [, second] = sentTo(th);
    expect(second).toMatchObject({ n: 2, kind: "template", template: "quote_reminder_2" });
    expect(second!.text).toContain(second!.params.amount);
    await tick(at(200));
    await tick(at(1000));
    expect(sentTo(th).map((m) => m.n)).toEqual([1, 2]);
    expect(await ledger(th, "chaser_sent")).toHaveLength(2);
  });

  it("a long outage does not send both in one tick: chaser 2 is at least 24h behind chaser 1", async () => {
    const { th } = await optedIn(1);
    await tick(at(300));
    expect(sentTo(th).map((m) => m.n)).toEqual([1]);
    expect(sentTo(th)[0]!.kind).toBe("template"); // 299h after the customer's last message
    await tick(at(323.99));
    expect(sentTo(th).map((m) => m.n)).toEqual([1]);
    await tick(at(324));
    expect(sentTo(th).map((m) => m.n)).toEqual([1, 2]);
  });

  it("an opt-in that comes after the first chaser was due restarts the clock from the opt-in", async () => {
    const th = thread();
    await quote(th);
    await tick(at(24)); // no consent yet: cancelled
    await say(th, "haan", at(30));
    expect(await sentBy(th, at(53.99))).toEqual([]);
    expect(await sentBy(th, at(54))).toEqual([{ threadId: th, n: 1 }]);
    expect(sentTo(th)[0]!.kind).toBe("free_text");
  });
});

describe("cancellation: checked again under the lock when the chaser is due", () => {
  it("the chaser carries the code-issued payment link while the quote is unpaid", async () => {
    const { th } = await optedIn(1);
    await tick(at(25));
    expect(sentTo(th)[0]!.text).toContain("https://rzp.sim.invalid/");
  });

  it("payment collected: no chaser, and the cancellation says why", async () => {
    const { th, total } = await optedIn(1);
    const linkId = (await rows("SELECT provider_link_id FROM payments WHERE thread_id=$1", [th]))[0].provider_link_id as string;
    const ev = paidEvent({ linkId, tenantId: T.id, amount: total, eventId: `evt_${th}`, paymentId: `pay_${th}` });
    await handleWebhook({ pool: db.pool, kernel, payments: provider }, ev.body, ev.headers, at(5));
    await tick(at(25));
    await tick(at(73));
    expect(sentTo(th)).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["payment_collected"]);
  });

  it("the customer replies (and is not re-quoted): no chaser, and the reply cancels it at once", async () => {
    const { th } = await optedIn(1);
    await handleEnquiry(deps(), { ...base(th, "can you do a discount?", at(3)), fields: { ...GOOD, intent: "discount_request" } });
    expect((await rows("SELECT status FROM timers WHERE kind='chaser' AND subject_id=$1", [th]))[0].status).toBe("done");
    await tick(at(25));
    await tick(at(73));
    expect(sentTo(th)).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["customer_reply"]);
  });

  it("a reply that leads to a new quote restarts the schedule from the new quote, for the new total", async () => {
    const { th } = await optedIn(1);
    const second = await quote(th, at(10), { fields: { guestCount: 200 } });
    if (second.outcome.kind !== "quote") throw new Error("expected a quote");
    expect(await sentBy(th, at(25))).toEqual([]); // the old 24h mark means nothing now
    expect(await sentBy(th, at(34))).toEqual([{ threadId: th, n: 1 }]);
    expect(sentTo(th)[0]!.text).toContain(sentTo(th)[0]!.params.amount);
    expect(second.reply).toContain(sentTo(th)[0]!.params.amount);
  });

  it("owner takeover: no chaser while paused, and none after the handback either", async () => {
    const { th } = await optedIn(1);
    const seq = (await rows("SELECT tenant_seq::int AS s FROM ledger_entries WHERE thread_id=$1 AND type='quote'", [th]))[0].s as number;
    const owner = (text: string, now: string) => handleOwnerMessage({ pool: db.pool, kernel }, { tenant: T, senderRef: "+91 00000 60001", text, now });
    await owner(`reply Q${seq} Hello, this is the owner.`, at(2));
    await tick(at(25));
    expect(await owner(`handback Q${seq}`, at(26))).toBeDefined();
    await tick(at(73));
    expect(sentTo(th)).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["owner_takeover"]);
  });

  it("owner takeover then handback BEFORE the chaser is due: still no chaser (a human spoke to the customer)", async () => {
    const { th } = await optedIn(1);
    const seq = (await rows("SELECT tenant_seq::int AS s FROM ledger_entries WHERE thread_id=$1 AND type='quote'", [th]))[0].s as number;
    await handleOwnerMessage({ pool: db.pool, kernel }, { tenant: T, senderRef: "+91 00000 60001", text: `reply Q${seq} Hi from the owner`, now: at(2) });
    await handleOwnerMessage({ pool: db.pool, kernel }, { tenant: T, senderRef: "+91 00000 60001", text: `handback Q${seq}`, now: at(3) });
    await tick(at(25));
    expect(sentTo(th)).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["owner_takeover"]);
  });

  it("kill switch on when the chaser is due: cancelled for good, not delayed until it is switched off", async () => {
    const { th } = await optedIn(1);
    const flip = (on: boolean, now: string) => setKillSwitch({ pool: db.pool, kernel }, { target: { kind: "tenant", tenantId: T.id }, on, actor: { memberId: `${T.id}:member:owner:1` }, now });
    await flip(true, at(20));
    await tick(at(25));
    await flip(false, at(26));
    await tick(at(73));
    expect(sentTo(th)).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["kill_switch"]);
  });

  it("quote expired: no chaser once the quote's validity has passed (a 1-day quote at 25h)", async () => {
    const { th } = await optedIn(1, { card: shortCard });
    await tick(at(25));
    expect(sentTo(th)).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["quote_expired"]);
  });

  it("quote expires between chaser 1 and chaser 2: chaser 1 goes, chaser 2 is cancelled", async () => {
    const { th } = await optedIn(1, { card: midCard }); // valid 2 days: chaser 1 at 25h is inside it, chaser 2 at 73h is not
    await tick(at(25));
    await tick(at(73));
    expect(sentTo(th).map((m) => m.n)).toEqual([1]);
    expect(await cancelReasons(th)).toEqual(["quote_expired"]);
  });

  const native = { availability: nativeAvailability };
  it("a lapsed hold does not by itself cancel: a 12h hold gone at 13h, the date still free, chaser 1 goes at 25h", async () => {
    const { th } = await optedIn(1, { card: holdCard, fields: { date: "2027-03-01" }, extra: native });
    await tick(at(13)); // the hold-expiry timer releases the date
    expect((await rows("SELECT status FROM holds WHERE thread_id=$1", [th]))[0].status).toBe("expired");
    expect(await sentBy(th, at(25))).toEqual([{ threadId: th, n: 1 }]);
    expect(await cancelReasons(th)).toEqual([]);
  });

  it("native 48h hold lapses at 48h, the date is still free: chaser 1 at 25h and chaser 2 at 73h both go", async () => {
    const { th } = await optedIn(1, { fields: { date: "2027-04-10" }, extra: native });
    expect(await sentBy(th, at(25))).toEqual([{ threadId: th, n: 1 }]);
    await tick(at(49));
    expect((await rows("SELECT status FROM holds WHERE thread_id=$1", [th]))[0].status).toBe("expired");
    expect(await sentBy(th, at(73))).toEqual([{ threadId: th, n: 2 }]);
    expect(await cancelReasons(th)).toEqual([]);
  });

  it("the hold lapsed and someone else took the date: chaser 2 is cancelled as date_unavailable, and no chaser text claims a hold", async () => {
    const { th } = await optedIn(1, { fields: { date: "2027-04-11" }, extra: native });
    expect(await sentBy(th, at(25))).toEqual([{ threadId: th, n: 1 }]);
    await tick(at(49));
    await quote(thread(), at(50), { fields: { date: "2027-04-11" }, extra: native }); // another customer's quote holds the date now
    expect(await sentBy(th, at(73))).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["date_unavailable"]);
    for (const m of sentTo(th)) expect(m.text).not.toMatch(/hold|held|reserve/i);
  });
});

/** Every way a customer says stop that must be honoured. Each row is one message, as typed. */
const STOP_WORDS: [string, string][] = [
  // English
  ["english", "STOP"], ["english", "stop"], ["english", "Stop."], ["english", "  stop  \n"], ["english", "STOP!!!"], ["english", "Stop \u{1F64F}"],
  ["english", "please stop"], ["english", "Please STOP"], ["english", "plz stop"], ["english", "pls, stop"], ["english", "stop messaging me"], ["english", "stop sending messages"],
  ["english", "STOP ALL"], ["english", "unsubscribe"], ["english", "UNSUBSCRIBE"], ["english", "Unsubscribe me"], ["english", "unsubscribe."], ["english", "opt out"], ["english", "opt-out"], ["english", "OPTOUT"],
  ["english (full-width)", "\uFF33\uFF34\uFF2F\uFF30"], ["english (zero-width inside)", "st\u200Bop"],
  // Hinglish
  ["hinglish", "ruko"], ["hinglish", "Ruko"], ["hinglish", "RUKO!"], ["hinglish", "ruko."], ["hinglish", "please ruko"],
  ["hinglish", "band karo"], ["hinglish", "Band Karo!"], ["hinglish", "band kar do"], ["hinglish", "bandh karo"], ["hinglish", "band karo ye messages"],
  ["hinglish", "mat bhejo"], ["hinglish", "Mat bhejo please"], ["hinglish", "MAT BHEJO!!"], ["hinglish", "messages mat bhejo"], ["hinglish", "mat bhejna"], ["hinglish", "bas karo"],
  // Devanagari
  ["devanagari", "बंद करो"], ["devanagari", "बंद करो।"], ["devanagari", "बंद करो!"], ["devanagari", "बन्द करो"], ["devanagari", "बंद कर दो"], ["devanagari", "कृपया बंद करो"], ["devanagari", "ये मैसेज बंद करो"],
  // Contains-anywhere stems (a missed stop is the dangerous side)
  ["english", "please unsubscribe me from this"], ["english", "I want to unsubscribe from these messages"], ["english", "How do I OPT OUT of this?"], ["english", "STOPALL"], ["english", "QUIT"], ["english", "Quit!"],
  ["english", "stop sending me these reminders"], ["english", "Stop messaging me, thanks"], ["english", "stop texting me"], ["english", "stop bothering me, I booked elsewhere"], ["english", "please stop contacting me"],
  ["english", "don't message me again"], ["english", "Don\u2019t contact me"], ["english", "Do not contact me."], ["english", "dont text me"], ["english", "never message me again"], ["english", "please do not contact me"],
  ["english", "No more messages"], ["english", "no more messages!!"], ["english", "I said stop"], ["english", "I SAID STOP!!!"], ["english", "i said stop already, why do you keep sending"],
  ["hinglish", "mujhe message mat bhejo"], ["hinglish", "Mujhe messages mat bhejo!"], ["hinglish", "messages bhejna band karo"], ["hinglish", "ab bhejna band kijiye"], ["hinglish", "bhejna band"], ["hinglish", "aap mujhe baar baar mat bhejo"],
  ["devanagari", "मुझे मैसेज भेजना बंद करो"], ["devanagari", "ये सब बंद करो अब"], ["devanagari", "कृपया मुझे बार बार मत भेजो"],
  ["devanagari", "रुको"], ["devanagari", "रुको!"], ["devanagari", "रुको।"], ["devanagari", "मत भेजो"], ["devanagari", "मत भेजो।"], ["devanagari", "मैसेज मत भेजो"], ["devanagari", "मत भेजना"], ["devanagari", "बस करो"],
];
/** Messages that mention stopping but are conversation about the quote, not a request to be unsubscribed. */
const NOT_STOP = [
  "don't stop now", "please don't stop the quote", "can you stop by tomorrow to discuss the 12th", "I will not unsubscribe, send the quote again",
  "Stop. Can we do the 20th instead, with 200 guests?", "stopover hotel for the guests?", "ruko main date check karta hoon", "ruko, kal baat karte hain", "रुको मैं तारीख देखता हूँ",
  "band karo mat, pehle rate batao please", "yes", "ok thanks",
  "do not stop sending the quote", "never stop messaging me with offers", "mat roko", "I did not unsubscribe, why was I removed", "please don't opt out the team",
];

describe("stop words", () => {
  const stopped = async (text: string) => {
    const { th } = await optedIn(1);
    const calls = extractCalls;
    const r = await say(th, text, at(2));
    return { th, r, llmCalls: extractCalls - calls };
  };

  it.each(STOP_WORDS)("%s: %j revokes consent, tells the customer once, and no model sees it", async (_lang, text) => {
    for (const form of new Set([text, text.normalize("NFC"), text.normalize("NFD")])) {
      const { th, r, llmCalls } = await stopped(form);
      expect(r.consent).toBe("revoked");
      expect(r.reply).toBe(UNSUBSCRIBED_NOTICE);
      expect(llmCalls).toBe(0);
      expect((await consentStatus(db.pool, T.id, ref(th))).status).toBe("revoked");
      expect((await ledger(th, "stop")).map((e) => e.payload)).toMatchObject([{ confirmed: true, customerId: `${T.id}:cust:${ref(th)}` }]);
    }
  });

  it.each(NOT_STOP)("%j is a normal message: consent stays, and the pipeline answers it", async (text) => {
    const { th, r, llmCalls } = await stopped(text);
    if (text === "yes" || text === "ok thanks") expect(r.consent).toBeUndefined();
    expect(r.consent).not.toBe("revoked");
    expect(llmCalls).toBe(1);
    expect((await consentStatus(db.pool, T.id, ref(th))).status).toBe("granted");
    expect(await ledger(th, "stop")).toEqual([]);
  });
});

describe("a stop word, end to end", () => {
  it("cancels the pending chasers, so nothing is sent at 24h or 72h", async () => {
    const { th } = await optedIn(1);
    await say(th, "STOP", at(2));
    await tick(at(25));
    await tick(at(73));
    expect(sentTo(th)).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["stop_word"]);
  });

  it("stop after chaser 1: chaser 2 never goes", async () => {
    const { th } = await optedIn(1);
    await tick(at(25));
    await say(th, "ruko", at(30));
    await tick(at(73));
    expect(sentTo(th).map((m) => m.n)).toEqual([1]);
  });

  it("the customer is told once; a second stop word gets no reply and no second revocation", async () => {
    const { th } = await optedIn(1);
    expect((await say(th, "stop", at(2))).reply).toBe(UNSUBSCRIBED_NOTICE);
    expect((await say(th, "STOP!!", at(3))).reply).toBe("");
    expect((await say(th, "बंद करो", at(4))).reply).toBe("");
    expect((await ledger(th, "consent")).map((e) => e.payload.action)).toEqual(["requested", "granted", "revoked"]);
    expect((await ledger(th, "stop")).map((e) => e.payload.confirmed)).toEqual([true, false, false]);
  });

  it("revocation persists: a new quote does not ask again, no chaser ever goes, and a later 'yes' is just a message", async () => {
    const { th } = await optedIn(1);
    await say(th, "stop", at(2));
    const again = await handleEnquiry(deps(), { ...base(th, "one more quote please", at(10)), fields: { ...GOOD, guestCount: 150 } });
    expect(again.outcome.kind).toBe("quote");
    expect(again.reply).not.toContain("Reply YES");
    const calls = extractCalls;
    const yes = await say(th, "yes", at(11));
    expect(yes.consent).toBeUndefined();
    expect(extractCalls).toBe(calls + 1);
    await tick(at(40));
    await tick(at(200));
    expect(sentTo(th)).toEqual([]);
    expect((await consentStatus(db.pool, T.id, ref(th))).status).toBe("revoked");
    expect(await cancelReasons(th)).toContain("consent_revoked");
  });

  it("a stop with no consent ever given is still recorded and answered once; and on a thread that does not exist yet", async () => {
    const th = thread();
    const r = await say(th, "Unsubscribe", at(1));
    expect(r.reply).toBe(UNSUBSCRIBED_NOTICE);
    expect((await consentStatus(db.pool, T.id, ref(th))).status).toBe("revoked");
    expect(await rows("SELECT 1 FROM threads WHERE id=$1", [th])).toEqual([]);
  });

  it("revokes for the customer, not the thread: pending chasers on all of their threads are cancelled", async () => {
    const { th: first } = await optedIn(1);
    const second = thread();
    const q2 = await handleEnquiry(deps(), { ...base(second, "another quote", at(2)), customerRef: ref(first), fields: { ...GOOD, date: "2027-05-01" } });
    expect(q2.outcome.kind).toBe("quote");
    await handleMessage(deps(), { ...base(second, "mat bhejo", at(3)), customerRef: ref(first) });
    await tick(at(100));
    expect(sentTo(first)).toEqual([]);
    expect(sentTo(second)).toEqual([]);
    expect(await cancelReasons(first)).toEqual(["stop_word"]);
  });

  it("is honoured while the thread is paused for the owner and while the kill switch is on", async () => {
    const { th } = await optedIn(1);
    const seq = (await rows("SELECT tenant_seq::int AS s FROM ledger_entries WHERE thread_id=$1 AND type='quote'", [th]))[0].s as number;
    await handleOwnerMessage({ pool: db.pool, kernel }, { tenant: T, senderRef: "+91 00000 60001", text: `reply Q${seq} Hello`, now: at(2) });
    expect((await say(th, "stop", at(3))).reply).toBe(UNSUBSCRIBED_NOTICE);
    const { th: th2 } = await optedIn(1);
    const flip = (on: boolean, now: string) => setKillSwitch({ pool: db.pool, kernel }, { target: { kind: "tenant", tenantId: T.id }, on, actor: { memberId: `${T.id}:member:owner:1` }, now });
    await flip(true, at(4));
    try {
      expect((await say(th2, "band karo", at(5))).reply).toBe(UNSUBSCRIBED_NOTICE);
    } finally {
      await flip(false, at(6));
    }
    expect((await consentStatus(db.pool, T.id, ref(th2))).status).toBe("revoked");
  });
});

describe("concurrency (real races, row locks)", () => {
  /** Holds the thread row lock in an open transaction (a customer message or stop word "in flight"), runs `fn` inside it, commits after `release`. */
  async function withThreadLockHeld(th: string, inFlight: (c: import("pg").PoolClient) => Promise<void>, during: () => Promise<unknown>): Promise<void> {
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [T.id]);
      await c.query("SELECT 1 FROM threads WHERE id=$1 FOR UPDATE", [th]);
      const racing = during(); // the tick claims the timer, then waits for the thread lock we hold
      await new Promise((r) => setTimeout(r, 150));
      await inFlight(c);
      await c.query("COMMIT");
      await racing;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  it("three ticks at once send a due chaser exactly once", async () => {
    const { th } = await optedIn(1);
    await Promise.all([tick(at(25)), tick(at(25)), tick(at(25))]);
    expect(sentTo(th)).toHaveLength(1);
    expect(await ledger(th, "chaser_sent")).toHaveLength(1);
  });

  it("a customer message committed while the tick waits on the thread lock: the chaser sees it at send time and does not go", async () => {
    const { th } = await optedIn(1);
    await withThreadLockHeld(
      th,
      (c) => appendEntry(c, kernel, { tenantId: T.id, threadId: th, at: at(24), type: "enquiry", payload: { text: "actually, one more question" } }).then(() => undefined),
      () => tick(at(25)),
    );
    expect(sentTo(th)).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["customer_reply"]);
  });

  it("a stop word committed while the tick waits on the thread lock: no chaser", async () => {
    const { th } = await optedIn(1);
    await withThreadLockHeld(
      th,
      (c) => import("./consent.js").then((m) => m.appendConsent(c, kernel, { tenantId: T.id, threadId: th, customerId: `${T.id}:cust:${ref(th)}`, action: "revoked", source: "stop_word", at: at(24) })).then(() => undefined),
      () => tick(at(25)),
    );
    expect(sentTo(th)).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["consent_revoked"]);
  });

  it("a send in flight while a customer reply and a stop word arrive: no deadlock, the chaser goes once, and chaser 2 never does", async () => {
    const { th } = await optedIn(1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = { send: async (m: ChaserMessage) => { await gate; sent.push(m); } };
    const ticking = runDueTimers(db.pool, at(25), { kernel, chaserOutbox: slow });
    await new Promise((r) => setTimeout(r, 150)); // the tick holds the timer and thread locks, blocked in send
    const reply = handleEnquiry(deps(), { ...base(th, "and the 13th?", at(25)), fields: { ...GOOD, date: "2026-12-13" } });
    const stop = say(th, "stop", at(25));
    await new Promise((r) => setTimeout(r, 150));
    release();
    const [, , stopped] = await Promise.all([ticking, reply, stop]);
    expect(stopped.consent).toBe("revoked");
    expect(sentTo(th).map((m) => m.n)).toEqual([1]);
    await tick(at(100));
    expect(sentTo(th).map((m) => m.n)).toEqual([1]);
  });
});

describe("tenancy", () => {
  const B = { id: "tenant-chasers-b", name: "FICTIONAL: Other Banquets" };
  it("one tenant's stop word does not touch the same phone's consent at another tenant, and neither can read the other's consent, chasers or timers", async () => {
    await seedApprovedCard({ pool: db.pool, kernel }, { tenant: B, card, now: T0 });
    const th = thread();
    const mine = await optedIn(1);
    const bThread = `${th}-b`;
    const common = { customerRef: ref(mine.th), rateCard: card, availability: { blockedDates: [] } };
    await handleEnquiry(deps(), { ...common, tenant: B, threadId: bThread, now: T0, message: "quote?", fields: { ...GOOD } });
    await handleMessage(deps(), { ...common, tenant: B, threadId: bThread, now: at(1), message: "yes" });
    await say(mine.th, "stop", at(2)); // tenant T's customer stops
    expect((await consentStatus(db.pool, T.id, ref(mine.th))).status).toBe("revoked");
    expect((await consentStatus(db.pool, B.id, ref(mine.th))).status).toBe("granted");
    await tick(at(25));
    expect(sent.filter((m) => m.tenantId === B.id && m.threadId === bThread)).toHaveLength(1);
    expect(sentTo(mine.th)).toEqual([]);

    // As tenant B (row-level security), none of tenant T's consent, stop, chaser or timer rows are visible, and none can be written.
    const seen = await withTenant(db.pool, B.id, async (c) => ({
      ledger: (await c.query("SELECT count(*)::int AS n FROM ledger_entries WHERE tenant_id=$1 AND type IN ('consent','stop','chaser_sent','chase')", [T.id])).rows[0].n,
      timers: (await c.query("SELECT count(*)::int AS n FROM timers WHERE tenant_id=$1 AND kind='chaser'", [T.id])).rows[0].n,
    }));
    expect(seen).toEqual({ ledger: 0, timers: 0 });
    await expect(
      withTenant(db.pool, B.id, (c) => c.query("INSERT INTO timers (tenant_id, kind, subject_id, run_at) VALUES ($1,'chaser','x',now())", [T.id])),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("ledger", () => {
  it("the hash chain still verifies after consent, stop, chase and chaser_sent entries (and the races above)", async () => {
    const verdict = await verifyLedger(db.pool, kernel, { tenantId: T.id });
    expect(verdict.ok).toBe(true);
    const kinds = (await rows("SELECT DISTINCT type FROM ledger_entries WHERE type IN ('consent','stop','chase','chaser_sent') ORDER BY type")).map((r) => r.type);
    expect(kinds).toEqual(["chase", "chaser_sent", "consent", "stop"]);
  });
});

