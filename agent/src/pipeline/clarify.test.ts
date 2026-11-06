import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel } from "../kernel/index.js";
import type { Quote } from "../kernel/types.js";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import { handleEnquiry } from "./handle-enquiry.js";
import { runFixture } from "../simulator/run-fixture.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const CARD_PATH = fileURLToPath(new URL("../../../rate-cards/fictional-banquet.json", import.meta.url));
const TENANT = { id: "tenant-rose-court", name: "FICTIONAL: Rose Court Banquets" };

const threadRow = async (pool: pg.Pool, id: string) =>
  (await pool.query("SELECT state, fields FROM threads WHERE id = $1", [id])).rows[0];

describe("missing information: ask, then quote", () => {
  it("one-message incomplete enquiry ends with exactly one clarifying question from the card", async () => {
    const events: EscalationEvent[] = [];
    const r = await runFixture("fixtures/banquet-03-incomplete.json", { pool: db.pool, notifier: collectingNotifier(events) });
    expect(r.quote).toEqual({ kind: "refusal", reason: "missing_required_field", ruleGap: "date" });
    expect(r.reply).toContain("Which date do you have in mind?");
    expect(r.reply.match(/\?/g)).toHaveLength(1);
    expect(r.reply).not.toMatch(/\d/);
    expect(r.reply).not.toMatch(/guests|locality|Noida/i);
    expect(events).toEqual([]); // a question is not an escalation
    expect(r.ledgerRow.type).toBe("refusal");
    const t = await threadRow(db.pool, r.ledgerRow.threadId);
    expect(t.state).toBe("open");
    expect(t.fields).toMatchObject({ service: "banquet", guestCount: 80 });
  });

  it("two-message conversation asks for the guest count, then quotes; thread persists across fresh connections", async () => {
    const url = (db.pool as unknown as { options: { connectionString: string } }).options.connectionString;
    const poolA = new pg.Pool({ connectionString: url });
    const first = await runFixture("fixtures/banquet-02-two-step.json", { pool: poolA, only: 0 });
    await poolA.end();
    expect(first.reply).toContain("Roughly how many guests?");
    expect(first.reply).not.toMatch(/\d/);

    const poolB = new pg.Pool({ connectionString: url });
    const second = await runFixture("fixtures/banquet-02-two-step.json", { pool: poolB, only: 1 });
    const t = await threadRow(poolB, second.ledgerRow.threadId);
    await poolB.end();

    expect(second.quote.kind).toBe("quote");
    expect((second.quote as Quote).total).toBe(56_640_000);
    expect(second.reply).toContain("₹5,66,400");
    expect(second.reply).toContain("12 Dec 2026");
    expect(t.state).toBe("quoted");
    expect(t.fields).toMatchObject({ service: "banquet", date: "2026-12-12", guestCount: 120 });
  });

  it("running the whole fixture yields both turns, with a ledger row for each outcome", async () => {
    const fresh = await createTestDb(); // the earlier test already advanced this fixture's thread
    const r = await runFixture("fixtures/banquet-02-two-step.json", { pool: fresh.pool });
    expect(r.turns.map((t) => t.quote.kind)).toEqual(["refusal", "quote"]);
    expect(r.quote.kind).toBe("quote");
    const { rows } = await fresh.pool.query("SELECT type FROM ledger_entries WHERE thread_id = $1 AND type IN ('refusal','quote') ORDER BY seq", [
      r.ledgerRow.threadId,
    ]);
    expect(rows.map((x) => x.type)).toEqual(["refusal", "quote"]);
    await fresh.drop();
  });

  it("never asks for a field the card does not require", async () => {
    const kernel = await loadKernel();
    const card = JSON.parse(await readFile(CARD_PATH, "utf8")) as { requiredFields: { field: string; question: string }[] };
    const required = card.requiredFields.map((f) => f.field);
    const questions = new Map(card.requiredFields.map((f) => [f.field, f.question]));
    const all: Record<string, unknown> = { service: "banquet", date: "2026-12-12", guestCount: 120 };
    // Every subset of required fields present, plus an extra field the card does not require.
    for (let mask = 0; mask < 7; mask++) {
      const fields: Record<string, unknown> = { locality: "somewhere", language: "en", confidenceBps: 9000 };
      required.forEach((f, i) => {
        if (mask & (1 << i)) fields[f] = all[f];
      });
      const res = await handleEnquiry(
        { pool: db.pool, kernel, notifier: collectingNotifier([]) },
        {
          tenant: TENANT,
          threadId: `t-subset-${mask}`,
          customerRef: `c-${mask}`,
          rateCard: card,
          rateCardVersion: 1,
          now: "2026-11-07T10:00:00Z",
          availability: { blockedDates: [] },
          message: "x",
          fields,
        },
      );
      const asked = required.filter((f) => res.reply.includes(questions.get(f) as string));
      const missing = required.filter((_, i) => !(mask & (1 << i)));
      expect(asked).toEqual(missing.slice(0, 1));
      expect(res.reply).not.toMatch(/locality|where/i);
    }
  });

  it("does not ask for a field that a card does not list as required", async () => {
    const kernel = await loadKernel();
    const card = JSON.parse(await readFile(CARD_PATH, "utf8")) as { requiredFields: { field: string }[] };
    const relaxed = { ...card, requiredFields: card.requiredFields.filter((f) => f.field !== "date") };
    const res = await handleEnquiry(
      { pool: db.pool, kernel, notifier: collectingNotifier([]) },
      {
        tenant: TENANT,
        threadId: "t-relaxed",
        customerRef: "c-relaxed",
        rateCard: relaxed,
        rateCardVersion: 2,
        now: "2026-11-07T10:00:00Z",
        availability: { blockedDates: [] },
        message: "x",
        fields: { service: "banquet", guestCount: 120, language: "en", confidenceBps: 9000 },
      },
    );
    expect(res.reply).not.toContain("Which date do you have in mind?");
    // The kernel does not ask about date when the card does not require it.
    expect(res.outcome).not.toMatchObject({ reason: "missing_required_field" });
  });
});
