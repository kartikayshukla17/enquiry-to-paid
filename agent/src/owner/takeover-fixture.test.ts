/** T18 fix round 1: the takeover demo through the simulator seam (runFixture). All data FICTIONAL. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { collectingNotifier } from "../escalation/index.js";
import { runFixture, type OwnerLine, type RunResult } from "../simulator/run-fixture.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe("takeover demo (fixtures/owner-02-takeover.json)", () => {
  it("the held customer message reaches the owner and manager through the owner outbox, and the ledger row names exactly those recipients", async () => {
    const run: RunResult = await runFixture("fixtures/owner-02-takeover.json", { pool: db.pool, notifier: collectingNotifier([]) });
    const lines: OwnerLine[] = run.ownerTranscript ?? [];
    const surfaced = lines.filter((l) => l.dir === "to_owner" && l.kind === "customer_message");
    expect(surfaced.map((l) => (l.dir === "to_owner" ? l.to : ""))).toEqual(["owner", "manager"]);
    expect(surfaced[0]!.dir === "to_owner" && surfaced[0]!.text).toContain("Can you do the 20th instead?");

    expect(run.turns.map((t) => t.held)).toEqual([undefined, true]);
    expect(run.turns[1]!.reply).toBe("");

    const rows = (await db.pool.query("SELECT payload FROM ledger_entries WHERE tenant_id='tenant-takeover-demo' AND type='owner_message' AND payload->>'command'='customer_message_surfaced'")).rows;
    expect(rows).toHaveLength(1);
    const to = (rows[0] as { payload: { to: string[] } }).payload.to;
    expect(to).toHaveLength(surfaced.length);
    const roles = (await db.pool.query("SELECT role FROM members WHERE id = ANY($1) ORDER BY role", [to])).rows.map((r: { role: string }) => r.role);
    expect(roles).toEqual(["manager", "owner"]);
  });
});
