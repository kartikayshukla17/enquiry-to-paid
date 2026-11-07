/** T17 fix round 1: kill switch blocks owner quotes, concurrent replies cannot double-send, digest always ledgers, generic denial text. FICTIONAL data. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { setKillSwitch } from "../killswitch/index.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { seedTenant } from "../payments/test-helpers.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { handleOwnerMessage } from "./handle.js";
import { sendDailyDigest } from "./inbound.js";
import { createOwnerNotifier } from "./notifier.js";
import { seedOwnerMembers } from "./seed.js";
import { collectingOutbox, type OwnerOutgoing } from "./types.js";

let db: TestDb;
let kernel: KernelBridge;
let card: unknown;
const T = { id: "tenant-fix1", name: "FICTIONAL: Fix One" };
const NOQ = { id: "tenant-fix1-quiet", name: "FICTIONAL: Fix One Quiet" };
const OWNER = "+91 00000 30001", MANAGER = "+91 00000 30002", STAFF = "+91 00000 30003", QUIET_OWNER = "+91 00000 40001";
const OPERATOR = { operator: "fictional-operator" };
const NOW = "2026-11-07T10:00:00Z";
const outbox: OwnerOutgoing[] = [];

beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
  card = await seedTenant(db.pool, kernel, T);
  await seedTenant(db.pool, kernel, NOQ);
  await seedOwnerMembers(db.pool, T.id, [{ role: "owner", phone: OWNER }, { role: "manager", phone: MANAGER }, { role: "staff", phone: STAFF }]);
  await seedOwnerMembers(db.pool, NOQ.id, [{ role: "owner", phone: QUIET_OWNER }]);
});
afterAll(async () => {
  await db.drop();
});

async function refuse(thread: string) {
  const notifier = createOwnerNotifier({ pool: db.pool, kernel, outbox: collectingOutbox(outbox) });
  await handleEnquiry(
    { pool: db.pool, kernel, notifier },
    { tenant: T, threadId: thread, customerRef: `cust-${thread}`, rateCard: card, now: NOW, availability: { blockedDates: [] }, message: "cheaper?",
      fields: { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9000, intent: "discount_request" } },
  );
}
const say = (from: string, text: string) => handleOwnerMessage({ pool: db.pool, kernel }, { tenant: T, senderRef: from, text, now: NOW });
const rows = async (sql: string, args: unknown[] = []) => (await withTenant(db.pool, T.id, (c) => c.query(sql, args))).rows;
const count = async (type: string) => (await rows("SELECT count(*)::int AS n FROM ledger_entries WHERE type=$1", [type]))[0].n as number;
const refOf = async (thread: string) => `R${(await rows("SELECT tenant_seq::int AS n FROM ledger_entries WHERE thread_id=$1 AND type='refusal' ORDER BY tenant_seq DESC LIMIT 1", [thread]))[0].n}`;
const flip = (target: Parameters<typeof setKillSwitch>[1]["target"], on: boolean) =>
  setKillSwitch({ pool: db.pool, kernel }, { target, on, actor: target.kind === "global" ? OPERATOR : { memberId: `${T.id}:member:owner:1` }, now: NOW });

describe("K1: the kill switch blocks owner quotes", () => {
  for (const scope of ["tenant", "global"] as const) {
    it(`${scope} switch on: quote is refused with a templated reply, logged, nothing priced or sent; decline, why, digest, call them still work; off again: quote works`, async () => {
      const a = `k1-${scope}-a`, b = `k1-${scope}-b`;
      await refuse(a);
      await refuse(b);
      const target = scope === "global" ? ({ kind: "global" } as const) : ({ kind: "tenant", tenantId: T.id } as const);
      await flip(target, true);
      const before = await count("owner_quote");
      const q = await say(OWNER, `quote ${await refOf(a)} 85000`);
      expect(q.reply).toBe("Kill switch is on; turn it off to send a price");
      expect(q.customerMessages).toEqual([]);
      expect(await count("owner_quote")).toBe(before);
      const logged = await rows("SELECT payload FROM ledger_entries WHERE type='owner_message' AND payload->>'rejected'='kill_switch'");
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.at(-1)!.payload).toMatchObject({ command: "quote", rejected: "kill_switch" });
      expect((await rows("SELECT state FROM threads WHERE id=$1", [a]))[0].state).toBe("refused");

      expect((await say(OWNER, `why ${await refOf(a)}`)).reply).toContain("the agent did not quote this enquiry");
      expect((await say(OWNER, "digest")).reply).toContain("Daily summary");
      expect((await say(OWNER, `call them ${await refOf(a)}`)).reply).toContain("call-back");
      const d = await say(OWNER, `decline ${await refOf(b)}`);
      expect(d.customerMessages).toHaveLength(1);

      await flip(target, false);
      const ok = await say(OWNER, `quote ${await refOf(a)} 85000`);
      expect(ok.customerMessages).toHaveLength(1);
      expect(await count("owner_quote")).toBe(before + 1);
    });
  }
});

describe("C1: concurrent owner and manager replies cannot double-send", () => {
  it("two simultaneous quotes on one enquiry: exactly one owner_quote and one customer message", async () => {
    await say(OWNER, "digest"); // make sure the operations thread exists, so its creation does not serialise the two replies
    await refuse("c1-a");
    const ref = await refOf("c1-a");
    const before = await count("owner_quote");
    // Hold the tenant's ledger head lock so both replies are in flight together (otherwise the race depends on timing).
    const hold = await db.pool.connect();
    await hold.query("BEGIN");
    await hold.query("SELECT 1 FROM ledger_heads WHERE tenant_id=$1 FOR UPDATE", [T.id]);
    const both = Promise.all([say(OWNER, `quote ${ref} 80000`), say(MANAGER, `quote ${ref} 90000`)]);
    await new Promise((r) => setTimeout(r, 400));
    await hold.query("COMMIT");
    hold.release();
    const [x, y] = await both;
    expect(x.customerMessages.length + y.customerMessages.length).toBe(1);
    expect(await count("owner_quote")).toBe(before + 1);
    const loser = x.customerMessages.length === 0 ? x : y;
    expect(loser.reply).toMatch(/not waiting/);
  });
});

describe("M2: the daily digest always writes its ledger entry", () => {
  it("a tenant with no prior owner messages still gets a digest_sent entry", async () => {
    expect((await withTenant(db.pool, NOQ.id, (c) => c.query("SELECT 1 FROM ledger_entries WHERE type='owner_message'"))).rowCount).toBe(0);
    const r = await sendDailyDigest({ pool: db.pool, outbox: collectingOutbox(outbox), kernel }, { tenant: NOQ, now: NOW });
    expect(r.sentTo).toHaveLength(1);
    const sent = (await withTenant(db.pool, NOQ.id, (c) => c.query("SELECT payload FROM ledger_entries WHERE type='owner_message'"))).rows;
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ command: "digest_sent" });
  });
});

describe("M3: staff denial text is generic", () => {
  it("does not hard-code a ref", async () => {
    const r = await say(STAFF, "quote 5000");
    expect(r.reply).toBe("Sorry, only the owner or a manager can do that. You can ask me for the digest or say why with a ref from an escalation message.");
    expect(r.reply).not.toMatch(/R\d/);
  });
});
