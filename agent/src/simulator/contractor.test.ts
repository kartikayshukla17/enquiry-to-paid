import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectingNotifier, formatEscalation, type EscalationEvent } from "../escalation/index.js";
import type { Quote } from "../kernel/types.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { holdingReply } from "../pipeline/reply.js";
import { REPO_ROOT, runFixture } from "./run-fixture.js";

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

const card = async () => JSON.parse(await readFile(path.join(REPO_ROOT, "rate-cards/fictional-contractor.json"), "utf8")) as { refusalSuggestionReply: string };

describe("contractor fixtures: the card quotes a narrow set and refuses the rest with a suggested site visit", () => {
  it("contractor-01: a narrow covered repair is quoted, no suggestion, no escalation", async () => {
    const { r, events } = await run("contractor-01-quote");
    const q = r.quote as Quote;
    expect(q.kind).toBe("quote");
    expect(q.total).toBe(94_400);
    expect(r.reply).toContain("Tap repair (first item, visit included): ₹800");
    expect(r.reply).not.toContain("site visit");
    expect(events).toHaveLength(0);
  });

  it.each([
    ["contractor-02-renovation", "service"],
    ["contractor-03-other-locality", "locality"],
    ["contractor-04-over-size-cap", "quantity"],
  ])("%s: typed no_covering_rule, the card's own site-visit wording, an escalation carrying the suggestion", async (name, gap) => {
    const { r, events } = await run(name);
    expect(r.quote).toMatchObject({ kind: "refusal", reason: "no_covering_rule", ruleGap: gap, suggestion: "book_site_visit" });
    const { suggestion } = JSON.parse(JSON.stringify(r.quote)) as { suggestion: string };
    expect(suggestion).toBe("book_site_visit");

    // reply = the generic holding text + the card-provided template, verbatim; no number anywhere
    const template = (await card()).refusalSuggestionReply;
    expect(r.reply).toBe(`${holdingReply("no_covering_rule")} ${template}`);
    expect(r.reply).not.toMatch(/\d/);
    expect(r.reply).not.toMatch(/₹/);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "no_covering_rule", ruleGap: gap, suggestion: "book_site_visit" });
    expect(formatEscalation(events[0]!)).toContain("suggestion=book_site_visit");

    // and the suggestion is a ledger fact on the refusal row
    const { rows } = await db.pool.query("SELECT type, payload FROM ledger_entries WHERE seq = $1", [r.ledgerRow.seq]);
    expect(rows[0].type).toBe("refusal");
    expect(rows[0].payload).toMatchObject({ reason: "no_covering_rule", suggestion: "book_site_visit" });
  });

  it("contractor-05: a clarifying question is not a refusal: no suggestion, no escalation", async () => {
    const { r, events } = await run("contractor-05-missing-field");
    expect(r.quote).toMatchObject({ kind: "refusal", reason: "missing_required_field", ruleGap: "quantity" });
    expect((r.quote as { suggestion?: string }).suggestion).toBeUndefined();
    expect(r.reply).toContain("How many items need work?");
    expect(r.reply).not.toContain("site visit");
    expect(events).toHaveLength(0);
  });

  it("a card with no suggestion keeps the plain holding reply and an escalation without a suggestion", async () => {
    const events: EscalationEvent[] = [];
    const r = await runFixture("fixtures/wedding-300-out-of-season.json", { pool: db.pool, notifier: collectingNotifier(events) });
    expect(r.quote).toMatchObject({ kind: "refusal", reason: "no_covering_rule" });
    expect(r.reply).toBe(holdingReply("no_covering_rule"));
    expect(events[0]?.suggestion).toBeUndefined();
    expect(formatEscalation(events[0]!)).not.toContain("suggestion=");
  });
});
