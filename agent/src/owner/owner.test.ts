/** T17 owner channel. Seams: runFixture (the simulator, owner steps), handleOwnerMessage/routeInbound/buildDigest, SQL as e2p_app. All data FICTIONAL. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import { runFixture, type RunResult } from "../simulator/run-fixture.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe("the owner demo, driven through the simulator (fixtures/owner-01.json)", () => {
  let run: RunResult;
  const events: EscalationEvent[] = [];
  beforeAll(async () => {
    run = await runFixture("fixtures/owner-01.json", { pool: db.pool, notifier: collectingNotifier(events) });
  });
  const lines = () => run.ownerTranscript ?? [];

  it("a refusal is escalated to the owner and the manager (not staff) with the quick replies", () => {
    const first = lines().filter((l) => l.dir === "to_owner" && l.kind === "escalation").slice(0, 2);
    expect(first.map((l) => (l.dir === "to_owner" ? l.to : ""))).toEqual(["owner", "manager"]);
    const text = first[0]!.text;
    expect(text).toMatch(/^\[R\d+\] FICTIONAL: Marigold Hall: a customer enquiry needs you\./);
    expect(text).toContain("quote ₹__ / decline / call them");
    expect(text).toContain("They asked: banquet, 13 Jun 2027, 300 guests");
    expect(text).toContain("Why: No rate-card rule covers this enquiry");
    expect(text).not.toMatch(/\+91|\d{10}/); // never a phone number
  });
});
