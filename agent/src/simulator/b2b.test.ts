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

describe("B2B supplier fixtures through the same pipeline (no vertical code)", () => {
  it("b2b-01: a volume order is priced at the band unit price with GST as its own line", async () => {
    const { r, events } = await run("b2b-01-quote");
    const q = r.quote as Quote;
    expect(q.kind).toBe("quote");
    expect(q.lines.map((l) => l.ruleId)).toEqual(["bolts-unit-price", "small-order-handling", "gst-18"]);
    expect(q.lines.map((l) => l.amount)).toEqual([787_500, 50_000, 150_750]);
    expect(q.total).toBe(988_250);
    expect(r.reply).toContain("Steel bolts, unit price by volume band: ₹7,875");
    expect(r.reply).toContain("GST 18%: ₹1,507.50");
    expect(r.reply).toContain("Here is your quote for 750 units");
    expect(events).toHaveLength(0);
  });

  it("b2b-02: below a refuse-MOQ the order is refused with a holding reply (no price) and escalated", async () => {
    const { r, events } = await run("b2b-02-below-moq-refused");
    expect(r.quote).toMatchObject({ kind: "refusal", reason: "out_of_policy", ruleGap: "below_minimum:quantity" });
    expect(r.reply).not.toMatch(/\d/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "out_of_policy", ruleGap: "below_minimum:quantity" });
  });

  it("b2b-03: below a raise-MOQ the quote is for the minimum and the reply says so, using the card's own label", async () => {
    const { r, events } = await run("b2b-03-below-moq-requoted");
    const q = r.quote as Quote;
    expect(q.kind).toBe("quote");
    expect(q.lines[0]).toMatchObject({ ruleId: "ties-unit-price", amount: 90_000 }); // 500 * 180
    expect(r.reply).toContain("Minimum order quantity (nylon-ties: 500) applies, so this quote is for 500 instead of the 120 you asked for.");
    expect(r.reply).toContain("Here is your quote for 500 units");
    expect(events).toHaveLength(0);
    // the stored fields stay what the customer said; only the quote was raised
    expect(r.fields.quantity).toBe(120);
  });

  it("b2b-04: the tier boundary is inclusive and, with all-units pricing, 500 units can total less than 499", async () => {
    const { r } = await run("b2b-04-tier-boundary");
    const [a, b] = r.turns.map((t) => (t.quote as Quote).total);
    expect(a).toBe(765_584); // 499 units at 12.00 + handling + GST
    expect(b).toBe(678_500); // 500 units at 10.50 + handling + GST
    expect(b).toBeLessThan(a!);
  });

  it("b2b-05: more than the card covers is refused as no_covering_rule, never quoted", async () => {
    const { r, events } = await run("b2b-05-out-of-coverage");
    expect(r.quote).toMatchObject({ kind: "refusal", reason: "no_covering_rule" });
    expect(events).toHaveLength(1);
  });
});
