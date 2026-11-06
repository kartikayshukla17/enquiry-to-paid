/**
 * US10 through the pipeline seam: runFixture / handleEnquiry quoting under each approval state.
 * "An unapproved card cannot quote", "editing a source after approval has no effect until re-approved",
 * "a tampered approved snapshot refuses", and "template == JSON card" (identical fixtures, identical quotes).
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import type { Quote } from "../kernel/types.js";
import { verifyLedger } from "../ledger/index.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { holdingReply } from "../pipeline/reply.js";
import { runFixture } from "../simulator/run-fixture.js";
import { startApproval, submitApproval } from "./approve.js";
import { compileTemplate, readTemplateDir, type TemplateFiles } from "./compile.js";
import { seedApprovedCard } from "./legacy.js";
import { REPO_ROOT } from "./paths.js";
import { publishDraft } from "./store.js";

let db: TestDb;
let kernel: KernelBridge;
let files: TemplateFiles;
const NOW = "2026-11-07T10:00:00Z";

beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
  files = await readTemplateDir(path.join(REPO_ROOT, "rate-cards/templates/fictional-banquet-template"));
});
afterAll(async () => {
  await db.drop();
});

describe("the template card prices exactly like the JSON card", () => {
  it("identical fixtures give identical replies, totals, lines and card hash", async () => {
    const json = await runFixture("fixtures/banquet-01.json", { pool: db.pool });
    const tpl = await runFixture("fixtures/card-template-banquet-01.json", { pool: db.pool });
    expect(json.quote.kind).toBe("quote");
    expect(tpl.quote).toEqual(json.quote); // includes rateCardHash: the same hash
    expect(tpl.reply).toBe(json.reply);
  });
});

describe("an unapproved card cannot quote", () => {
  it("a compiled but never approved card gives a typed out_of_policy refusal, the holding reply, an escalation and no number", async () => {
    const events: EscalationEvent[] = [];
    const r = await runFixture("fixtures/card-unapproved-banquet-01.json", { pool: db.pool, notifier: collectingNotifier(events) });
    expect(r.quote).toEqual({ kind: "refusal", reason: "out_of_policy", ruleGap: "card_not_approved" });
    expect(r.reply).toBe(holdingReply("out_of_policy"));
    expect(r.reply).not.toMatch(/\d|₹/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "out_of_policy", ruleGap: "card_not_approved", tenantId: "tenant-rose-court-draft" });
    expect(r.ledgerRow.type).toBe("refusal");
    expect(r.ledgerRow.rateCardHash).toBeNull();
    const quotes = await db.pool.query("SELECT 1 FROM ledger_entries WHERE tenant_id='tenant-rose-court-draft' AND type='quote'");
    expect(quotes.rowCount).toBe(0);
  });

  it("the honest 'are you a bot?' answer still works without an approved card", async () => {
    const tenant = { id: "tenant-no-card", name: "FICTIONAL: No Card Hall" };
    const card = compileOk(files);
    await publishDraft({ pool: db.pool, kernel }, { tenant, card });
    const res = await ask(tenant, card, { language: "en", confidenceBps: 9500, intent: "asks_if_bot" });
    expect(res.outcome.kind).toBe("disclosure");
  });
});

const compileOk = (f: TemplateFiles) => {
  const r = compileTemplate(f, kernel);
  if (!r.ok) throw new Error("template should compile");
  return r.card;
};

let n = 0;
async function ask(tenant: { id: string; name: string }, card: Record<string, unknown>, fields: Record<string, unknown> = { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9200 }, events: EscalationEvent[] = []) {
  return handleEnquiry(
    { pool: db.pool, kernel, notifier: collectingNotifier(events) },
    { tenant, threadId: `${tenant.id}:th:${++n}`, customerRef: `c-${n}`, rateCard: card, now: NOW, availability: { blockedDates: [] }, message: "m", fields },
  );
}

describe("editing a source after approval has no effect until re-approved", () => {
  const tenant = { id: "tenant-edit-after-approval", name: "FICTIONAL: Edit Hall" };
  // weekend hall 2,50,000 -> 2,60,000
  const editedFiles = (): TemplateFiles => ({ ...files, "rules.csv": (files["rules.csv"] ?? "").replace("250000", "260000") });
  let v1Total: number;
  let v1Hash: string;

  it("the approved card quotes", async () => {
    await seedApprovedCard({ pool: db.pool, kernel }, { tenant, card: compileOk(files), now: NOW });
    const r = await ask(tenant, compileOk(files));
    expect(r.outcome.kind).toBe("quote");
    v1Total = (r.outcome as Quote).total;
    v1Hash = (r.outcome as Quote).rateCardHash;
  });

  it("a new compile of an edited source is a draft: quoting still comes from the approved snapshot, at the old price and hash", async () => {
    const v2 = await publishDraft({ pool: db.pool, kernel }, { tenant, card: compileOk(editedFiles()) });
    expect(v2.status).toBe("draft");
    // the caller even hands the pipeline the EDITED card: it is only used to say which card is meant
    const r = await ask(tenant, compileOk(editedFiles()));
    expect(r.outcome).toMatchObject({ kind: "quote", total: v1Total, rateCardHash: v1Hash });
  });

  it("after re-approval the new version quotes at the new price", async () => {
    const { readbacks } = await startApproval({ pool: db.pool, kernel }, { tenantId: tenant.id, cardId: "fictional-banquet", now: NOW });
    await submitApproval({ pool: db.pool, kernel }, { tenantId: tenant.id, cardId: "fictional-banquet", version: 2, memberId: `${tenant.id}:legacy-seed-owner`, answers: Object.fromEntries(readbacks.map((r) => [r.id, "yes" as const])), now: NOW });
    const r = await ask(tenant, compileOk(editedFiles()));
    const q = r.outcome as Quote;
    expect(q.kind).toBe("quote");
    expect(q.rateCardHash).not.toBe(v1Hash);
    expect(q.total).toBeGreaterThan(v1Total);
  });

  it("a stored approved snapshot that no longer matches its pinned hash refuses (card_hash_mismatch) and escalates", async () => {
    await db.pool.query(`UPDATE rate_cards SET compiled = jsonb_set(compiled, '{rules,1,charge,amount}', '1') WHERE tenant_id=$1 AND status='approved'`, [tenant.id]);
    const events: EscalationEvent[] = [];
    const r = await ask(tenant, compileOk(editedFiles()), undefined, events);
    expect(r.outcome).toEqual({ kind: "refusal", reason: "out_of_policy", ruleGap: "card_hash_mismatch" });
    expect(events).toHaveLength(1);
  });

  it("the ledger chain verifies after approvals, quotes and refusals", async () => {
    expect((await verifyLedger(db.pool, kernel)).ok).toBe(true);
  });
});
