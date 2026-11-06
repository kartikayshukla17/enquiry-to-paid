import { seedApprovedCard } from "../ratecard/legacy.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectingNotifier } from "../escalation/index.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { verifyLedger } from "../ledger/index.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { REPO_ROOT } from "../simulator/run-fixture.js";
import { encryptPii, phoneHash, piiKeysFromEnv } from "../security/pii.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { handleOwnerCommand, parseOwnerCommand } from "./commands.js";
import { nativeAvailability } from "./native.js";

describe("parseOwnerCommand (deterministic, no LLM)", () => {
  it.each([
    ["block 2026-12-12 hall maintenance", { kind: "block", start: "2026-12-12", end: "2026-12-12", reason: "hall maintenance" }],
    ["  BLOCK   2026-12-12  ", { kind: "block", start: "2026-12-12", end: "2026-12-12", reason: "" }],
    ["block 2026-12-12 to 2026-12-14 family wedding", { kind: "block", start: "2026-12-12", end: "2026-12-14", reason: "family wedding" }],
    ["unblock 2026-12-12", { kind: "unblock", date: "2026-12-12" }],
    ["Show blocks", { kind: "show_blocks" }],
    ["list blocks", { kind: "show_blocks" }],
  ])("%s", (text, expected) => {
    expect(parseOwnerCommand(text)).toEqual(expected);
  });

  it.each(["hello", "I want to block my calendar sometime", "what is the price", "unblocking is fun", ""])("%j is not a command", (text) => {
    expect(parseOwnerCommand(text)).toBeUndefined();
  });

  it.each(["block", "block next saturday", "block 2026-13-45", "block 2026-12-14 to 2026-12-12 x", "unblock", "unblock 2026-02-30"])("%j is a usage error, never a guess", (text) => {
    expect(parseOwnerCommand(text)).toMatchObject({ kind: "usage" });
  });
});

describe("owner commands end to end", () => {
  let db: TestDb;
  let kernel: KernelBridge;
  let card: { version: number };
  const tenant = { id: "tenant-cmd", name: "FICTIONAL: Command Hall" };
  const NOW = "2026-11-07T10:00:00Z";
  const OWNER = "owner-ref", MANAGER = "manager-ref", STAFF = "staff-ref", STRANGER = "stranger-ref";

  beforeAll(async () => {
    kernel = await loadKernel();
    card = JSON.parse(await readFile(path.join(REPO_ROOT, "rate-cards/fictional-banquet.json"), "utf8")) as { version: number };
    db = await createTestDb();
    const pii = piiKeysFromEnv();
    await db.pool.query("INSERT INTO tenants (id, name) VALUES ($1,$2)", [tenant.id, tenant.name]);
    await seedApprovedCard({ pool: db.pool, kernel }, { tenant, card, now: NOW });
    for (const [ref, role] of [[OWNER, "owner"], [MANAGER, "manager"], [STAFF, "staff"]] as const) {
      await db.pool.query("INSERT INTO members (id, tenant_id, role, phone_hash, phone_enc) VALUES ($1,$2,$3,$4,$5)", [`m-${role}`, tenant.id, role, phoneHash(pii, ref), encryptPii(pii, ref)]);
    }
  });
  afterAll(async () => {
    await db.drop();
  });

  const say = (senderRef: string, text: string, now = NOW) => handleOwnerCommand({ pool: db.pool, kernel }, { tenant, senderRef, text, now });
  const enquire = (customer: string, date: string, now = NOW) =>
    handleEnquiry(
      { pool: db.pool, kernel, notifier: collectingNotifier([]), availability: nativeAvailability },
      {
        tenant, threadId: `${tenant.id}:th:${customer}`, customerRef: customer, rateCard: card, now,
        availability: { blockedDates: [] }, message: "m",
        fields: { service: "banquet", date, guestCount: 120, language: "en", confidenceBps: 9000 },
      },
    );

  it("a non-command is not handled (so it can go to the normal pipeline)", async () => {
    expect(await say(OWNER, "hello there")).toEqual({ handled: false, reply: "" });
  });

  it("owner blocks a date: the next enquiry for it is refused, nothing is quoted, and the ledger records the command", async () => {
    const r = await say(OWNER, "block 2026-12-12 hall maintenance");
    expect(r.reply).toBe("Blocked 12 Dec 2026 (hall maintenance). New enquiries for it will be told it is not available.");
    expect(r.ledgerRow).toMatchObject({ type: "owner_message", payload: { command: "block", start: "2026-12-12", end: "2026-12-12", reason: "hall maintenance", memberId: "m-owner" } });
    const e = await enquire("cust-1", "2026-12-12");
    expect(e.outcome).toMatchObject({ kind: "refusal", reason: "date_unavailable" });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM holds WHERE tenant_id=$1", [tenant.id])).rows[0].n).toBe(0);
  });

  it("show blocks lists it; unblock frees the date and the next enquiry quotes", async () => {
    expect((await say(MANAGER, "show blocks")).reply).toBe("Blocked dates:\n- 12 Dec 2026: hall maintenance");
    expect((await say(MANAGER, "unblock 2026-12-12")).reply).toBe("Unblocked 12 Dec 2026.");
    expect((await say(MANAGER, "unblock 2026-12-12")).reply).toBe("12 Dec 2026 was not blocked.");
    expect((await say(MANAGER, "show blocks")).reply).toBe("No dates are blocked.");
    expect((await enquire("cust-2", "2026-12-12")).outcome.kind).toBe("quote");
  });

  it("unblocking one day of a range splits it", async () => {
    await say(OWNER, "block 2027-01-10 to 2027-01-14 renovation");
    await say(OWNER, "unblock 2027-01-12");
    expect((await say(OWNER, "show blocks")).reply).toBe("Blocked dates:\n- 10 Jan 2027 to 11 Jan 2027: renovation\n- 13 Jan 2027 to 14 Jan 2027: renovation");
    expect((await enquire("cust-3", "2027-01-12")).outcome.kind).toBe("quote");
    expect((await enquire("cust-4", "2027-01-13")).outcome.kind).toBe("refusal");
  });

  it("staff and strangers are refused, nothing is written, and the attempt is logged", async () => {
    for (const who of [STAFF, STRANGER]) {
      const r = await say(who, "block 2027-03-06 sneaky");
      expect(r.reply).toMatch(/only the owner or a manager/i);
      expect(r.ledgerRow?.payload).toMatchObject({ denied: true });
    }
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM availability_blocks WHERE start_date='2027-03-06'");
    expect(rows[0].n).toBe(0);
  });

  it("past dates, overlaps and malformed commands change nothing and say why", async () => {
    expect((await say(OWNER, "block 2026-11-01 too late")).reply).toMatch(/already passed/);
    await say(OWNER, "block 2027-04-03 x");
    expect((await say(OWNER, "block 2027-04-03 again")).reply).toMatch(/overlaps a block that already exists/);
    expect((await say(OWNER, "block someday")).reply).toMatch(/Say it like/);
  });

  it("the tenant's ledger chain (owner commands, holds, quotes) verifies", async () => {
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM ledger_entries WHERE tenant_id=$1 AND type='owner_message'", [tenant.id]);
    expect(rows[0].n).toBeGreaterThan(8);
    expect(await verifyLedger(db.pool, kernel, { tenantId: tenant.id })).toMatchObject({ ok: true });
  });
});
