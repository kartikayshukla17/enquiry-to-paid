import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import type { Quote } from "../kernel/types.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { runFixture } from "./run-fixture.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const run = async (name: string) => {
  const events: EscalationEvent[] = [];
  const r = await runFixture(`fixtures/${name}.json`, { pool: db.pool, notifier: collectingNotifier(events) });
  return { r, events };
};

describe("photographer fixtures through the same pipeline (no vertical code)", () => {
  it("photographer-01: a package quote with GST, numbers straight from the kernel", async () => {
    const { r, events } = await run("photographer-01-quote");
    const q = r.quote as Quote;
    expect(q.kind).toBe("quote");
    expect(q.lines.map((l) => l.ruleId)).toEqual(["pkg-standard", "gst-18"]);
    expect(q.total).toBe(5_310_000);
    expect(r.reply).toContain("Standard package (6 hours included): ₹45,000");
    expect(r.reply).toContain("GST 18%: ₹8,100");
    expect(r.reply).toContain("Total: ₹53,100");
    expect(events).toHaveLength(0);
    const { rows } = await db.pool.query("SELECT type, rate_card_hash FROM ledger_entries WHERE seq = $1", [r.ledgerRow.seq]);
    expect(rows[0]).toMatchObject({ type: "quote", rate_card_hash: q.rateCardHash });
  });

  it("photographer-02: extra hours and a travel band appear as their own lines", async () => {
    const { r } = await run("photographer-02-extra-hours");
    const q = r.quote as Quote;
    expect(q.kind).toBe("quote");
    expect(q.lines.map((l) => l.ruleId)).toEqual(["pkg-premium", "extra-hours-premium", "travel", "weekend-surcharge", "gst-18"]);
    expect(q.lines.reduce((s, l) => s + l.amount, 0)).toBe(q.total);
    expect(r.reply).toContain("Extra coverage hours (Premium): ₹6,000");
    expect(r.reply).toContain("Travel: ₹3,500");
  });

  it("photographer-03: a missing package gets the card's own question, in a thread that stays open", async () => {
    const { r, events } = await run("photographer-03-missing-field");
    expect(r.quote).toMatchObject({ kind: "refusal", reason: "missing_required_field", ruleGap: "package" });
    expect(r.reply).toContain("Which package would you like: Basic, Standard or Premium?");
    expect(events).toHaveLength(0); // a clarifying question is not an escalation
    const { rows } = await db.pool.query("SELECT state FROM threads WHERE id = $1", ["tenant-lensfolk:thread:photographer-03-missing-field"]);
    expect(rows[0].state).toBe("open");
  });

  it("photographer-04: a venue outside the coverage radius is refused, never quoted, and escalated", async () => {
    const { r, events } = await run("photographer-04-out-of-coverage");
    expect(r.quote).toMatchObject({ kind: "refusal", reason: "no_covering_rule" });
    expect(r.reply).not.toMatch(/\d/);
    expect(r.reply).toContain("passed it to them");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "no_covering_rule", ruleGap: "distanceKm" });
  });
});
