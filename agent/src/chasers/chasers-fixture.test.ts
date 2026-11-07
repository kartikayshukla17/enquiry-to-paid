/** T19 demo through the simulator seam (runFixture): the whole story from quote to chasers to stop. All data FICTIONAL. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { collectingNotifier } from "../escalation/index.js";
import { runFixture } from "../simulator/run-fixture.js";
import { UNSUBSCRIBED_NOTICE } from "./index.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe("chasers fixtures", () => {
  it("chasers-01: opt-in, chaser 1 at 24h as free text, chaser 2 at 72h as a template, then nothing", async () => {
    const run = await runFixture("fixtures/chasers-01.json", { pool: db.pool, notifier: collectingNotifier([]) });
    expect(run.turns[0]!.reply).toContain("Reply YES");
    expect(run.turns[1]!.reply).toContain("at most two reminders");
    expect(run.chasers?.map((m) => [m.n, m.kind, m.template ?? null, m.at])).toEqual([
      [1, "free_text", null, "2026-11-08T11:00:00Z"],
      [2, "template", "quote_reminder_2", "2026-11-10T11:00:00Z"],
    ]);
    expect(run.ticks?.map((t) => t.chasersSent)).toEqual([0, 1, 0, 1, 0]);
  });

  it("chasers-02: a stop word after chaser 1 is acknowledged once and chaser 2 never goes", async () => {
    const run = await runFixture("fixtures/chasers-02-stop.json", { pool: db.pool, notifier: collectingNotifier([]) });
    expect(run.chasers?.map((m) => m.n)).toEqual([1]);
    expect(run.turns.map((t) => t.reply).slice(2)).toEqual([UNSUBSCRIBED_NOTICE, ""]);
  });
});
