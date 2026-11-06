import { existsSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { startApproval, submitApproval, type Answer } from "./approve.js";
import { compileTemplate, formatCompileError, readTemplateDir } from "./compile.js";
import { REPO_ROOT } from "./paths.js";
import { CardError, publishDraft } from "./store.js";
import { withTenant } from "../tenancy/with-tenant.js";

const USAGE = `usage:
  pnpm card compile <template-dir>
      compiles the CSV sheets; prints the exact broken cells (exit 1) or the card hash (exit 0)
  pnpm card approve <template-dir> (--yes | --no <n>[,<n>...]) [--tenant <id>] [--member <id>] [--now <ISO-8601 UTC>]
      stores the compiled card as a draft, shows the kernel-priced worked examples, applies the simulated answers
      (--yes: every example correct; --no 2,3: those examples are wrong, the rest right) and approves only if all are yes
  pnpm card demo
      the whole story on a throwaway database: broken cell, approval, edit after approval, re-approval
  exit 0 ok / approved, 1 compile errors or not approved, 2 usage or setup error
`;

export interface CardCliDeps {
  /** Needed by approve; absent for compile. */
  pool?: Pool;
  kernel?: KernelBridge;
}

/** A directory as typed: absolute, relative to where the user ran the command, or relative to the repo root. */
export function resolveTemplateDir(p: string): string {
  const candidates = path.isAbsolute(p) ? [p] : [path.resolve(p), path.resolve(process.env.INIT_CWD ?? ".", p), path.join(REPO_ROOT, p)];
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new CardError("template_not_found", p);
  return hit;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export const DEMO_NOW = "2026-11-07T10:00:00Z";

export async function cardMain(argv: string[], deps: CardCliDeps = {}): Promise<{ code: number; out: string }> {
  const args = argv.filter((a) => a !== "--");
  const [cmd, dir] = args;
  if ((cmd !== "compile" && cmd !== "approve") || !dir) return { code: 2, out: USAGE };
  try {
    const kernel = deps.kernel ?? (await loadKernel());
    const files = await readTemplateDir(resolveTemplateDir(dir));
    const res = compileTemplate(files, kernel);
    if (!res.ok) {
      const lines = res.errors.map(formatCompileError);
      return { code: 1, out: `${lines.join("\n")}\ncompile: FAILED, ${lines.length} problem(s). Nothing was stored.\n` };
    }
    const head = `compile: OK ${String(res.card.id)} (card version ${String(res.card.version)}, ${(res.card.rules as unknown[]).length} rules)\ncard hash: ${res.hash}\n`;
    if (cmd === "compile") return { code: 0, out: head };

    if (!deps.pool) return { code: 2, out: "approve needs a database (DATABASE_URL)\n" };
    const yesAll = args.includes("--yes");
    const noList = flag(args, "--no");
    if (yesAll === (noList !== undefined)) return { code: 2, out: `approve needs exactly one of --yes or --no <n>[,<n>...]\n${USAGE}` };
    const tenantId = flag(args, "--tenant") ?? "tenant-demo-venue";
    const memberId = flag(args, "--member") ?? `${tenantId}:demo-owner`;
    const now = flag(args, "--now") ?? DEMO_NOW;
    if (Number.isNaN(Date.parse(now))) return { code: 2, out: "--now must be an ISO-8601 UTC instant\n" };
    const pool = deps.pool;
    const tenant = { id: tenantId, name: `FICTIONAL: ${tenantId}` };
    const cardId = String(res.card.id);

    const rev = await publishDraft({ pool, kernel }, { tenant, card: res.card, source: dir });
    // Demo convenience: the default member is created as an owner if it does not exist yet. Real members come from sign-in.
    if (flag(args, "--member") === undefined) {
      await withTenant(pool, tenantId, (c) => c.query("INSERT INTO members (id, tenant_id, role) VALUES ($1,$2,'owner') ON CONFLICT (id) DO NOTHING", [memberId, tenantId]));
    }
    if (rev.status === "approved") return { code: 0, out: `${head}tenant ${tenantId}: revision ${rev.version} is already approved and is the active card. Nothing to do.\n` };

    const { readbacks } = await startApproval({ pool, kernel }, { tenantId, cardId, version: rev.version, now });
    const no = new Set((noList ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const known = new Set(readbacks.map((r, i) => String(i + 1)));
    const stray = [...no].filter((n) => !known.has(n));
    if (stray.length > 0) return { code: 2, out: `--no refers to example(s) ${stray.join(", ")}, but there are only ${readbacks.length}\n` };
    const answers: Record<string, Answer> = {};
    let out = `${head}tenant ${tenantId}, revision ${rev.version} (draft). Read-back to ${memberId}:\n`;
    readbacks.forEach((r, i) => {
      const a: Answer = no.has(String(i + 1)) ? "no" : "yes";
      answers[r.id] = a;
      out += `  ${r.text}\n    -> simulated reply: ${a}\n`;
    });
    const result = await submitApproval({ pool, kernel }, {
      tenantId, cardId, version: rev.version, memberId, answers, now,
      reasons: Object.fromEntries(readbacks.filter((_, i) => no.has(String(i + 1))).map((r) => [r.id, "owner said the total is wrong"])),
    });
    if (result.approved) return { code: 0, out: `${out}approved: revision ${result.revision.version} is now the active card (hash ${result.revision.approvedHash ?? ""}, by ${memberId}).\n` };
    return { code: 1, out: `${out}NOT approved: ${result.reasons.join("; ")}. The card stays a draft and cannot quote.\n` };
  } catch (e) {
    if (e instanceof CardError) return { code: 2, out: `error: ${e.message}\n` };
    throw e;
  }
}
