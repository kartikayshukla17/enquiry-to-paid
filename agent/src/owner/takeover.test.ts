/** T18: owner takeover and handback. All data FICTIONAL. Seams: handleOwnerMessage, handleMessage, runDueTimers (injected clock), proofForThread. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { collectingNotifier } from "../escalation/index.js";
import type { LlmProvider } from "../llm/types.js";
import { handleMessage } from "../pipeline/handle-message.js";
import { seedTenant } from "../payments/test-helpers.js";
import { withTenant } from "../tenancy/with-tenant.js";
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

const at = (hoursAfterT0: number) => new Date(Date.parse(T0) + hoursAfterT0 * 3_600_000).toISOString();
const deps = () => ({ pool: db.pool, kernel, notifier: collectingNotifier([]), llm, ownerOutbox: collectingOutbox(outbox) });
const customer = (thread: string, message: string, now = T0) =>
  handleMessage(deps(), { tenant: T, threadId: thread, customerRef: `cust-${thread}`, rateCard: card, now, availability: { blockedDates: [] }, message });
const owner = (from: string, text: string, now = T0) => handleOwnerMessage({ pool: db.pool, kernel }, { tenant: T, senderRef: from, text, now });
const rows = async (sql: string, args: unknown[] = []) => (await withTenant(db.pool, T.id, (c) => c.query(sql, args))).rows;
const state = async (thread: string) => (await rows("SELECT state FROM threads WHERE id=$1", [thread]))[0]?.state as string;
const ledger = (thread: string, type?: string) =>
  rows(`SELECT type, payload, at FROM ledger_entries WHERE thread_id=$1 ${type ? "AND type=$2" : ""} ORDER BY tenant_seq`, type ? [thread, type] : [thread]);
const cmds = async (thread: string) => (await ledger(thread, "owner_message")).map((r) => r.payload.command as string);
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
