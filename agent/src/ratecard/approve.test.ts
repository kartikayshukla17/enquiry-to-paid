import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { verifyLedger } from "../ledger/index.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { generateReadbacks, startApproval, submitApproval, type Answer, type Readback } from "./approve.js";
import { compileTemplate, readTemplateDir, type TemplateFiles } from "./compile.js";
import { REPO_ROOT } from "./paths.js";
import { loadActiveCard, publishDraft, type CardRevision } from "./store.js";

const TEMPLATE = path.join(REPO_ROOT, "rate-cards/templates/fictional-banquet-template");
const NOW = "2026-11-07T10:00:00Z";
const TENANT = { id: "rose-court", name: "Rose Court (fictional)" };

let db: TestDb;
let kernel: KernelBridge;
let files: TemplateFiles;
const deps = () => ({ pool: db.pool, kernel });

beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
  files = await readTemplateDir(TEMPLATE);
});
afterAll(async () => {
  await db.drop();
});

function compiled(f: TemplateFiles = files): Record<string, unknown> {
  const r = compileTemplate(f, kernel);
  if (!r.ok) throw new Error("template should compile");
  return r.card;
}
const draft = (card = compiled(), source = "test") => publishDraft(deps(), { tenant: TENANT, card, source });
const yes = (rbs: Readback[]): Record<string, Answer> => Object.fromEntries(rbs.map((r) => [r.id, "yes" as const]));
const active = () => withTenant(db.pool, TENANT.id, (c) => loadActiveCard(c, kernel, TENANT.id, "fictional-banquet"));

async function member(id: string, role: "owner" | "manager" | "staff") {
  await withTenant(db.pool, TENANT.id, (c) => c.query("INSERT INTO members (id, tenant_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, TENANT.id, role]));
}

describe("read-back worked examples", () => {
  it("are 3 to 5, priced by the kernel, cover every core rule and the surcharge, and are deterministic", () => {
    const card = compiled();
    const a = generateReadbacks(kernel, card, NOW);
    expect(generateReadbacks(kernel, card, NOW)).toEqual(a);
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(a.length).toBeLessThanOrEqual(5);
    const covered = new Set(a.flatMap((r) => r.ruleIds));
    for (const id of ["hall-weekday", "hall-weekend", "catering-per-plate", "decor-by-size", "peak-season", "gst-18"]) expect(covered).toContain(id);
    for (const r of a) {
      // the total in the question is exactly what the kernel says for those fields
      const out = kernel.evaluate({ rateCard: card, fields: { ...r.fields, language: "en", confidenceBps: 10_000 }, availability: { blockedDates: [] }, now: NOW }) as { total: number };
      expect(out.total).toBe(r.total);
      expect(r.text).toContain("Correct?");
      expect(r.text).toContain("₹");
    }
    expect(a.some((r) => /Saturday|Sunday|Friday/.test(r.text) && r.ruleIds.includes("peak-season"))).toBe(true);
  });
});

describe("approval needs the read-backs", () => {
  let rev: CardRevision;
  let rbs: Readback[];

  it("a freshly compiled card is a draft and cannot be loaded as active", async () => {
    rev = await draft();
    expect(rev.status).toBe("draft");
    expect(rev.version).toBe(1);
    expect(await active()).toEqual({ ok: false, gap: "card_not_approved" });
  });

  it("cannot be approved without read-backs, with an incomplete set, or by staff", async () => {
    await member("m-owner", "owner");
    await member("m-staff", "staff");
    const base = { tenantId: TENANT.id, cardId: "fictional-banquet", version: 1, now: NOW };
    await expect(submitApproval(deps(), { ...base, memberId: "m-owner", answers: {} })).rejects.toThrow(/no_readbacks/);
    ({ readbacks: rbs } = await startApproval(deps(), base));
    await expect(submitApproval(deps(), { ...base, memberId: "m-owner", answers: { rb1: "yes" } })).rejects.toThrow(/readbacks_incomplete/);
    await expect(submitApproval(deps(), { ...base, memberId: "m-staff", answers: yes(rbs) })).rejects.toThrow(/not_authorised/);
    await expect(submitApproval(deps(), { ...base, memberId: "m-nobody", answers: yes(rbs) })).rejects.toThrow(/not_authorised/);
    expect(await active()).toEqual({ ok: false, gap: "card_not_approved" });
  });

  it("one 'no' keeps it a draft, records the reason and a ledger entry", async () => {
    const answers = { ...yes(rbs), rb2: "no" as const };
    const res = await submitApproval(deps(), { tenantId: TENANT.id, cardId: "fictional-banquet", version: 1, memberId: "m-owner", answers, reasons: { rb2: "weekend hall should be 2,60,000" }, now: NOW });
    expect(res.approved).toBe(false);
    if (res.approved) return;
    expect(res.reasons).toEqual(["rb2: weekend hall should be 2,60,000"]);
    expect(res.revision.status).toBe("draft");
    expect(res.revision.rejectionReason).toContain("rb2");
    expect(await active()).toEqual({ ok: false, gap: "card_not_approved" });
    const types = (await db.pool.query<{ type: string }>("SELECT type FROM ledger_entries WHERE tenant_id=$1 ORDER BY seq", [TENANT.id])).rows.map((r) => r.type);
    expect(types).toEqual(["rate_card_rejected"]);
  });

  it("all yes by an owner approves: member, time, pinned hash and a ledger entry carrying the card hash", async () => {
    const res = await submitApproval(deps(), { tenantId: TENANT.id, cardId: "fictional-banquet", version: 1, memberId: "m-owner", answers: yes(rbs), now: NOW });
    expect(res.approved).toBe(true);
    expect(res.revision).toMatchObject({ status: "approved", approvedBy: "m-owner", approvedAt: "2026-11-07T10:00:00.000Z", approvedHash: rev.contentHash });
    const a = await active();
    expect(a.ok && a.hash).toBe(rev.contentHash);
    const row = (await db.pool.query<{ type: string; rate_card_hash: string; thread_id: string | null }>("SELECT type, rate_card_hash, thread_id FROM ledger_entries WHERE type='rate_card_approved'")).rows[0];
    expect(row).toEqual({ type: "rate_card_approved", rate_card_hash: rev.contentHash, thread_id: null });
    await expect(submitApproval(deps(), { tenantId: TENANT.id, cardId: "fictional-banquet", version: 1, memberId: "m-owner", answers: yes(rbs), now: NOW })).rejects.toThrow(/already_approved/);
  });

  it("editing the source after approval makes a new draft revision; the approved snapshot keeps serving until re-approved", async () => {
    const edited = { ...files, "rules.csv": files["rules.csv"]!.replace("250000", "260000") };
    const v2 = await draft(compiled(edited), "edited");
    expect(v2).toMatchObject({ version: 2, status: "draft" });
    expect(v2.contentHash).not.toBe(rev.contentHash);
    const a = await active();
    expect(a.ok && a.hash).toBe(rev.contentHash); // still v1
    // compiling the same edit again does not pile up revisions
    expect((await draft(compiled(edited))).version).toBe(2);

    const { readbacks } = await startApproval(deps(), { tenantId: TENANT.id, cardId: "fictional-banquet", now: NOW });
    const res = await submitApproval(deps(), { tenantId: TENANT.id, cardId: "fictional-banquet", version: 2, memberId: "m-owner", answers: yes(readbacks), now: "2026-11-08T10:00:00Z" });
    expect(res.approved).toBe(true);
    const b = await active();
    expect(b.ok && b.hash).toBe(v2.contentHash);
    const states = (await db.pool.query<{ version: number; status: string }>("SELECT version, status FROM rate_cards WHERE tenant_id=$1 ORDER BY version", [TENANT.id])).rows;
    expect(states).toEqual([{ version: 1, status: "superseded" }, { version: 2, status: "approved" }]);
  });

  it("a stored approved card whose content no longer hashes to the pinned hash is refused", async () => {
    await db.pool.query(`UPDATE rate_cards SET compiled = jsonb_set(compiled, '{rules,0,charge,amount}', '1') WHERE tenant_id=$1 AND status='approved'`, [TENANT.id]);
    expect(await active()).toEqual({ ok: false, gap: "card_hash_mismatch" });
  });

  it("the ledger chain still verifies with tenant-level (thread-less) entries", async () => {
    expect((await verifyLedger(db.pool, kernel)).ok).toBe(true);
  });

  it("the app role cannot rewrite the compiled snapshot", async () => {
    await expect(
      withTenant(db.pool, TENANT.id, (c) => c.query("UPDATE rate_cards SET compiled='{}'::jsonb WHERE tenant_id=$1", [TENANT.id])),
    ).rejects.toThrow(/permission denied/);
  });
});
