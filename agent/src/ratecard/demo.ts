/** `pnpm card demo`: the T14 story end to end on a throwaway database. All data fictional. */
import path from "node:path";
import type { Pool } from "pg";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import { loadKernel } from "../kernel/index.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { startApproval, submitApproval } from "./approve.js";
import { parseCsv, toCsv } from "./csv.js";
import { compileTemplate, formatCompileError, readTemplateDir, type TemplateFiles } from "./compile.js";
import { REPO_ROOT } from "./paths.js";
import { publishDraft } from "./store.js";

const NOW = "2026-11-07T10:00:00Z";

function setCell(files: TemplateFiles, file: string, row: number, column: string, value: string): TemplateFiles {
  const rows = parseCsv(files[file] ?? "");
  const col = (rows[0] ?? []).indexOf(column);
  (rows[row - 1] as string[])[col] = value;
  return { ...files, [file]: toCsv(rows) };
}

export async function runDemo(pool: Pool): Promise<string> {
  const kernel = await loadKernel();
  const deps = { pool, kernel };
  const files = await readTemplateDir(path.join(REPO_ROOT, "rate-cards/templates/fictional-banquet-template"));
  const tenant = { id: "tenant-demo-venue", name: "FICTIONAL: Rose Court Banquets" };
  const owner = `${tenant.id}:owner`;
  let out = "";
  const say = (s = "") => (out += s + "\n");
  const compile = (f: TemplateFiles) => {
    const r = compileTemplate(f, kernel);
    if (!r.ok) throw new Error("demo template should compile");
    return r;
  };
  let n = 0;
  const ask = async (t: typeof tenant, card: Record<string, unknown>) => {
    const events: EscalationEvent[] = [];
    const r = await handleEnquiry(
      { pool, kernel, notifier: collectingNotifier(events) },
      { tenant: t, threadId: `${t.id}:th:${++n}`, customerRef: `demo-${n}`, rateCard: card, now: NOW, availability: { blockedDates: [] }, message: "Saturday 12 December 2026, 120 guests, quote please",
        fields: { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9300 } },
    );
    return { r, events };
  };
  const readbacksAndApprove = async (version: number, noOn: string[] = []) => {
    const { readbacks } = await startApproval(deps, { tenantId: tenant.id, cardId: "fictional-banquet", version, now: NOW });
    for (const rb of readbacks) say(`  ${rb.text}\n    -> ${noOn.includes(rb.id) ? "no" : "yes"}`);
    return submitApproval(deps, { tenantId: tenant.id, cardId: "fictional-banquet", version, memberId: owner, now: NOW, answers: Object.fromEntries(readbacks.map((rb) => [rb.id, noOn.includes(rb.id) ? ("no" as const) : ("yes" as const)])) });
  };

  say("== 1. Break a cell: rules.csv row 4 (catering per plate) gets 'abc' instead of a price ==");
  const broken = compileTemplate(setCell(files, "rules.csv", 4, "price", "abc"), kernel);
  if (!broken.ok) for (const e of broken.errors) say("  " + formatCompileError(e));
  say("  Nothing is stored; the owner fixes the cell and compiles again.\n");

  say("== 2. Compile the fixed template ==");
  const v1 = compile(files);
  say(`  OK, card hash ${v1.hash}`);
  const d1 = await publishDraft(deps, { tenant, card: v1.card, source: "rate-cards/templates/fictional-banquet-template" });
  await pool.query("INSERT INTO members (id, tenant_id, role) VALUES ($1,$2,'owner')", [owner, tenant.id]);
  say(`  stored as revision ${d1.version}: ${d1.status}\n`);

  say("== 3. Before approval the agent cannot quote ==");
  const blocked = await ask(tenant, v1.card);
  say(`  customer gets: ${blocked.r.reply}`);
  say(`  outcome: ${JSON.stringify(blocked.r.outcome)}; owner escalations: ${blocked.events.length}\n`);

  say("== 4. Approval needs read-backs (examples priced by the kernel). The owner says no to one ==");
  const rejected = await readbacksAndApprove(d1.version, ["rb2"]);
  say(`  approved: ${rejected.approved}${rejected.approved ? "" : " (" + rejected.reasons.join("; ") + ")"}\n`);

  say("== 5. Owner confirms every example ==");
  const ok = await readbacksAndApprove(d1.version);
  say(`  approved: ${ok.approved}\n`);
  const q1 = await ask(tenant, v1.card);
  say(`  customer gets:\n${q1.r.reply.split("\n").map((l) => "    " + l).join("\n")}\n`);

  say("== 6. Edit after approval: weekend hall hire goes from 2,50,000 to 2,60,000 and the sheet is compiled again ==");
  const v2 = compile(setCell(files, "rules.csv", 3, "price", "260000"));
  const d2 = await publishDraft(deps, { tenant, card: v2.card, source: "edited" });
  say(`  revision ${d2.version} is ${d2.status}; new hash ${v2.hash}`);
  const still = await ask(tenant, v2.card);
  const same = still.r.reply === q1.r.reply;
  say(`  customer asks again: ${same ? "the reply is unchanged, still the approved price" : "reply changed (unexpected)"} (quote hash ${(still.r.outcome as { rateCardHash?: string }).rateCardHash?.slice(0, 12)}... = revision 1)\n`);

  say("== 7. Re-approve the edited card ==");
  const again = await readbacksAndApprove(d2.version);
  say(`  approved: ${again.approved}`);
  const q2 = await ask(tenant, v2.card);
  say(`  customer gets:\n${q2.r.reply.split("\n").map((l) => "    " + l).join("\n")}`);
  return out;
}
