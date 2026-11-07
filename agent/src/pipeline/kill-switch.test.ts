import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import { KillSwitchError, setKillSwitch } from "../killswitch/index.js";
import { verifyLedger } from "../ledger/index.js";
import type { LlmProvider } from "../llm/types.js";
import { nativeAvailability } from "../availability/native.js";
import { seedApprovedCard } from "../ratecard/legacy.js";
import { loadCardSource } from "../ratecard/source.js";
import { runFixture, resolveFixture } from "../simulator/run-fixture.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { handleEnquiry } from "./handle-enquiry.js";
import { handleMessage } from "./handle-message.js";
import { holdingReply } from "./reply.js";

let db: TestDb;
let kernel: KernelBridge;
beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const CARD_PATH = fileURLToPath(new URL("../../../rate-cards/fictional-banquet.json", import.meta.url));
const T1 = { id: "tenant-ks-one", name: "FICTIONAL: Kill Switch One" };
const T2 = { id: "tenant-ks-two", name: "FICTIONAL: Kill Switch Two" };
const NOW = "2026-11-07T10:00:00Z";
const OPERATOR = { operator: "fictional-operator" };
const ownerOf = (t: { id: string }) => ({ memberId: `${t.id}:legacy-seed-owner` });
const deps = () => ({ pool: db.pool, kernel });

async function seedTenant(t: { id: string; name: string }, extraMembers: [string, string][] = []): Promise<unknown> {
  const card = JSON.parse(await readFile(CARD_PATH, "utf8")) as unknown;
  await seedApprovedCard(deps(), { tenant: t, card, now: NOW });
  for (const [id, role] of extraMembers) {
    await withTenant(db.pool, t.id, (c) => c.query("INSERT INTO members (id, tenant_id, role) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING", [id, t.id, role]));
  }
  return card;
}

describe("kill switch: flip mid-conversation (the ticket's demo)", () => {
  it("holding reply and escalation while on, no quote; quoting resumes when flipped back; flips are ledger entries", async () => {
    const events: EscalationEvent[] = [];
    const r = await runFixture("fixtures/kill-switch-01.json", { pool: db.pool, notifier: collectingNotifier(events) });
    expect(r.turns.map((t) => t.quote.kind)).toEqual(["quote", "refusal", "quote"]);
    const mid = r.turns[1]!;
    expect(mid.quote).toMatchObject({ kind: "refusal", reason: "kill_switch" });
    expect(mid.reply).toBe(holdingReply("kill_switch"));
    expect(mid.reply).not.toMatch(/\d/);
    expect(events.map((e) => e.reason)).toEqual(["kill_switch"]);
    expect(r.turns[2]!.reply).toBe(r.turns[0]!.reply);

    const { rows } = await db.pool.query("SELECT type, payload, at FROM ledger_entries WHERE type = 'kill_switch_changed' AND tenant_id = 'tenant-rose-court' ORDER BY tenant_seq");
    expect(rows.map((x) => ({ on: x.payload.on, scope: x.payload.scope, by: x.payload.actor.memberId, at: x.at.toISOString() }))).toEqual([
      { on: true, scope: "tenant", by: "tenant-rose-court:legacy-seed-owner", at: "2026-11-07T10:05:00.000Z" },
      { on: false, scope: "tenant", by: "tenant-rose-court:legacy-seed-owner", at: "2026-11-07T10:10:00.000Z" },
    ]);
  });
});

describe("who may flip", () => {
  it("only an owner member of that tenant may flip a tenant switch; refused flips change nothing and write no entry", async () => {
    await seedTenant(T1, [["ks1-manager", "manager"], ["ks1-staff", "staff"]]);
    await seedTenant(T2);
    const count = async () => ((await db.pool.query("SELECT count(*)::int AS n FROM ledger_entries WHERE type='kill_switch_changed'")).rows[0] as { n: number }).n;
    const before = await count();
    const flip = (actor: Parameters<typeof setKillSwitch>[1]["actor"], target: Parameters<typeof setKillSwitch>[1]["target"] = { kind: "tenant", tenantId: T1.id }) =>
      setKillSwitch(deps(), { target, on: true, actor, now: NOW });
    await expect(flip({ memberId: "ks1-manager" })).rejects.toMatchObject({ code: "not_owner" });
    await expect(flip({ memberId: "ks1-staff" })).rejects.toMatchObject({ code: "not_owner" });
    await expect(flip({ memberId: "nobody" })).rejects.toBeInstanceOf(KillSwitchError);
    // an owner of ANOTHER tenant cannot flip this one (the member is invisible under T1's RLS)
    await expect(flip(ownerOf(T2))).rejects.toMatchObject({ code: "unknown_member" });
    // a tenant owner cannot flip the global switch
    await expect(flip(ownerOf(T1), { kind: "global" })).rejects.toMatchObject({ code: "operator_required" });
    expect(await count()).toBe(before);
    expect((await withTenant(db.pool, T1.id, (c) => c.query("SELECT 1 FROM tenant_kill_switch WHERE on_flag"))).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM kill_switch_global WHERE on_flag")).rowCount).toBe(0);
  });
});

describe("scope", () => {
  it("a tenant switch stops only that tenant; a global switch stops all, with an entry on every tenant's chain; chains still verify", async () => {
    const card = await seedTenant(T1);
    await seedTenant(T2);
    const ask = async (t: { id: string; name: string }): Promise<string> => {
      const res = await handleEnquiry(
        { pool: db.pool, kernel, notifier: collectingNotifier([]) },
        { tenant: t, threadId: `${t.id}:thread:scope`, customerRef: "ks-cust", rateCard: card, now: NOW, availability: { blockedDates: [] }, message: "quote?", fields: { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9000 } },
      );
      return res.outcome.kind === "refusal" ? res.outcome.reason : res.outcome.kind;
    };
    await setKillSwitch(deps(), { target: { kind: "tenant", tenantId: T1.id }, on: true, actor: ownerOf(T1), now: NOW });
    expect([await ask(T1), await ask(T2)]).toEqual(["kill_switch", "quote"]);
    await setKillSwitch(deps(), { target: { kind: "tenant", tenantId: T1.id }, on: false, actor: ownerOf(T1), now: NOW });
    expect([await ask(T1), await ask(T2)]).toEqual(["quote", "quote"]);

    await setKillSwitch(deps(), { target: { kind: "global" }, on: true, actor: OPERATOR, now: "2026-11-07T11:00:00Z" });
    expect([await ask(T1), await ask(T2)]).toEqual(["kill_switch", "kill_switch"]);
    await setKillSwitch(deps(), { target: { kind: "global" }, on: false, actor: OPERATOR, now: "2026-11-07T12:00:00Z" });
    expect([await ask(T1), await ask(T2)]).toEqual(["quote", "quote"]);

    for (const t of [T1, T2]) {
      const rows = await withTenant(db.pool, t.id, (c) => c.query("SELECT payload FROM ledger_entries WHERE type='kill_switch_changed' AND payload->>'scope'='global' ORDER BY tenant_seq"));
      expect(rows.rows.map((r) => ({ on: r.payload.on, by: r.payload.actor.operator }))).toEqual([
        { on: true, by: "fictional-operator" },
        { on: false, by: "fictional-operator" },
      ]);
    }
    expect((await verifyLedger(db.pool, kernel)).ok).toBe(true);
  });

  it("the app role cannot write the global flag, and sees and writes only its own tenant's switch row (RLS)", async () => {
    await seedTenant(T1);
    await seedTenant(T2);
    await setKillSwitch(deps(), { target: { kind: "tenant", tenantId: T1.id }, on: true, actor: ownerOf(T1), now: NOW });
    await setKillSwitch(deps(), { target: { kind: "tenant", tenantId: T2.id }, on: true, actor: ownerOf(T2), now: NOW });
    const seen = await withTenant(db.pool, T1.id, (c) => c.query("SELECT tenant_id FROM tenant_kill_switch"));
    expect(seen.rows.map((r) => r.tenant_id)).toEqual([T1.id]);
    await expect(withTenant(db.pool, T1.id, (c) => c.query("UPDATE kill_switch_global SET on_flag = true"))).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(db.pool, T1.id, (c) => c.query("INSERT INTO tenant_kill_switch (tenant_id, on_flag, changed_at, changed_by) VALUES ($1, false, now(), 'x')", [T2.id])),
    ).rejects.toThrow(/row-level security|duplicate key/);
  });
});

/** An LLM that fails the test if it is touched at all. */
function forbiddenLlm(calls: { n: number }): LlmProvider {
  const boom = () => {
    calls.n++;
    return Promise.reject(new Error("the LLM must not be called while the kill switch is on"));
  };
  return { extract: boom, wordReply: boom };
}

describe("handleMessage: the switch is checked before extraction", () => {
  it("makes no LLM call while on, places no hold, refuses with the typed reason and escalates", async () => {
    const card = await seedTenant(T1);
    await setKillSwitch(deps(), { target: { kind: "global" }, on: true, actor: OPERATOR, now: NOW });
    const calls = { n: 0 };
    const events: EscalationEvent[] = [];
    const res = await handleMessage(
      { pool: db.pool, kernel, notifier: collectingNotifier(events), llm: forbiddenLlm(calls), wordReplies: true, availability: nativeAvailability },
      { tenant: T1, threadId: "ks-llm-thread", customerRef: "ks-cust-2", rateCard: card, now: NOW, availability: { blockedDates: [] }, message: "120 guests 12 December banquet, price?" },
    );
    expect(calls.n).toBe(0);
    expect(res.outcome).toMatchObject({ kind: "refusal", reason: "kill_switch" });
    expect(res.reply).toBe(holdingReply("kill_switch"));
    expect(events.map((e) => e.reason)).toEqual(["kill_switch"]);
    expect((await withTenant(db.pool, T1.id, (c) => c.query("SELECT 1 FROM holds WHERE thread_id = 'ks-llm-thread'"))).rowCount).toBe(0);
    await setKillSwitch(deps(), { target: { kind: "global" }, on: false, actor: OPERATOR, now: NOW });
  });
});

describe("structural: no pipeline path reaches kernel quoting while the switch is on", () => {
  it("every shipped fixture, with the global switch on, makes zero kernel evaluate calls and zero LLM calls and ends in kill_switch refusals only", async () => {
    let evaluateCalls = 0;
    const counting: KernelBridge = { ...kernel, evaluate: (i) => { evaluateCalls++; return kernel.evaluate(i); } };
    const calls = { n: 0 };
    const names = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("card-template") && !f.startsWith("two-tenants") && !f.startsWith("kill-switch"));
    expect(names.length).toBeGreaterThan(20);
    // Approving a card prices its read-backs through the kernel (setup, not the pipeline), so cards are approved first
    // with the real kernel; the fixture run then finds them already approved and only the pipeline turns are counted.
    for (const name of names) {
      const fx = JSON.parse(await readFile(resolveFixture(`fixtures/${name}`), "utf8")) as { tenant: { id: string; name: string }; rateCard: string; cardApproval?: string; now: string };
      if (fx.cardApproval === "unapproved") continue;
      await seedApprovedCard(deps(), { tenant: fx.tenant, card: await loadCardSource(fx.rateCard, kernel), now: fx.now, source: fx.rateCard });
    }
    // Quotes, disclosures and holds already in the database before the run must be the only ones after it.
    const counts = async () =>
      (await db.pool.query("SELECT (SELECT count(*) FROM ledger_entries WHERE type IN ('quote','disclosure','hold'))::int AS ledger, (SELECT count(*) FROM holds)::int AS holds")).rows[0] as { ledger: number; holds: number };
    const before = await counts();
    await setKillSwitch(deps(), { target: { kind: "global" }, on: true, actor: OPERATOR, now: NOW });
    let turns = 0;
    for (const name of names) {
      const r = await runFixture(`fixtures/${name}`, { pool: db.pool, kernel: counting, llm: forbiddenLlm(calls) });
      turns += r.turns.length;
      // A stop word is the one thing honoured while the switch is on (T19): it prices nothing and it is a legal duty. It reaches no kernel and no model.
      for (const t of r.turns) if (t.consent === undefined) expect(t.quote, name).toMatchObject({ kind: "refusal", reason: "kill_switch" });
    }
    expect(turns).toBeGreaterThan(20);
    expect(evaluateCalls).toBe(0);
    expect(calls.n).toBe(0);
    expect(await counts()).toEqual(before);
    await setKillSwitch(deps(), { target: { kind: "global" }, on: false, actor: OPERATOR, now: NOW });
  });
});
