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

  it("a hold that expired: no chaser", async () => {
    const { th } = await optedIn(1, { card: holdCard, fields: { date: "2027-03-01" }, extra: { availability: nativeAvailability } });
    await tick(at(13)); // the hold-expiry timer releases the date
    expect((await rows("SELECT status FROM holds WHERE thread_id=$1", [th]))[0].status).toBe("expired");
    await tick(at(25));
    expect(sentTo(th)).toEqual([]);
    expect(await cancelReasons(th)).toEqual(["hold_expired"]);
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
  ["devanagari", "रुको"], ["devanagari", "रुको!"], ["devanagari", "रुको।"], ["devanagari", "मत भेजो"], ["devanagari", "मत भेजो।"], ["devanagari", "मैसेज मत भेजो"], ["devanagari", "मत भेजना"], ["devanagari", "बस करो"],
];
/** Messages that mention stopping but are conversation about the quote, not a request to be unsubscribed. */
const NOT_STOP = [
  "don't stop now", "please don't stop the quote", "can you stop by tomorrow to discuss the 12th", "I will not unsubscribe, send the quote again",
  "Stop. Can we do the 20th instead, with 200 guests?", "stopover hotel for the guests?", "ruko main date check karta hoon", "ruko, kal baat karte hain", "रुको मैं तारीख देखता हूँ",
  "band karo mat, pehle rate batao please", "yes", "ok thanks",
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
// <<APPEND>>
