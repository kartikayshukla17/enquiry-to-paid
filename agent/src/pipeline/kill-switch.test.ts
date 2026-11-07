import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import { runFixture } from "../simulator/run-fixture.js";
import { holdingReply } from "./reply.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

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

    const { rows } = await db.pool.query("SELECT type, payload, at FROM ledger_entries WHERE type = 'kill_switch_changed' ORDER BY tenant_seq");
    expect(rows.map((x) => ({ on: x.payload.on, scope: x.payload.scope, by: x.payload.actor.memberId, at: x.at.toISOString() }))).toEqual([
      { on: true, scope: "tenant", by: "tenant-rose-court:legacy-seed-owner", at: "2026-11-07T10:05:00.000Z" },
      { on: false, scope: "tenant", by: "tenant-rose-court:legacy-seed-owner", at: "2026-11-07T10:10:00.000Z" },
    ]);
  });
});
