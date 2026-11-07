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
import { collectingChaserOutbox, type ChaserMessage } from "./index.js";

let db: TestDb;
let kernel: KernelBridge;
let card: { id: string; holdHours: number };
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
  // A shipped card quotes valid for 24-48h, which would expire before the 72h chaser; this one is valid for 5 days.
  const raw = JSON.parse(await readFile(fileURLToPath(new URL("../../../rate-cards/fictional-banquet.json", import.meta.url)), "utf8")) as typeof card;
  card = { ...raw, holdHours: 120 };
  await seedApprovedCard({ pool: db.pool, kernel }, { tenant: T, card, now: T0 });
});
afterAll(async () => {
  await db.drop();
});

const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString().replace(".000Z", "Z");
const sent: ChaserMessage[] = [];
const outbox = collectingChaserOutbox(sent);
const deps = () => ({ pool: db.pool, kernel, notifier: collectingNotifier([]), llm, chasers: true as const });
const ref = (thread: string) => `cust-${thread}`;
const base = (thread: string, message: string, now: string) => ({ tenant: T, threadId: thread, customerRef: ref(thread), rateCard: card, now, availability: { blockedDates: [] }, message });
/** The agent quotes (typed fields, as the pipeline would hand them over). */
const quote = (thread: string, now = T0) => handleEnquiry(deps(), { ...base(thread, "quote?", now), fields: { ...GOOD } });
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
async function optedIn(optInAfterHours = 1): Promise<{ th: string; reply: string }> {
  const th = thread();
  const q = await quote(th);
  await say(th, "yes", at(optInAfterHours));
  return { th, reply: q.reply };
}

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
// <<APPEND>>
