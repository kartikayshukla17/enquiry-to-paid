import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import type { Availability, ExtractedFields, Outcome } from "../kernel/types.js";
import type { LedgerRow } from "../ledger/index.js";
import { createLogNotifier, type Notifier } from "../escalation/index.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const AGENT_ROOT = path.join(REPO_ROOT, "agent");

interface Fixture {
  id: string;
  tenant: { id: string; name: string };
  rateCard: string; // path relative to repo root
  now: string;
  customerRef: string;
  availability: Availability;
  conversation: { from: string; text: string }[];
  extracted: ExtractedFields;
}

export interface RunResult {
  reply: string;
  quote: Outcome;
  fields: ExtractedFields & { date: string; guestCount: number };
  ledgerRow: LedgerRow;
}

export interface RunOptions {
  pool: Pool;
  kernel?: KernelBridge;
  /** Escalation sink; defaults to the logging stub. */
  notifier?: Notifier;
  /** Test hook: replace some extracted fields (still typed). */
  overrideFields?: Partial<ExtractedFields>;
}

/** Resolves a fixture path against cwd, agent/, then the invoking directory. */
export function resolveFixture(p: string): string {
  const candidates = path.isAbsolute(p)
    ? [p]
    : [path.resolve(p), path.join(AGENT_ROOT, p), path.resolve(process.env.INIT_CWD ?? ".", p)];
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new Error(`fixture not found: ${p}`);
  return hit;
}

/** The seam behind `pnpm sim run <fixture>`. */
export async function runFixture(fixturePath: string, opts: RunOptions): Promise<RunResult> {
  const fx = JSON.parse(await readFile(resolveFixture(fixturePath), "utf8")) as Fixture;
  const rateCard: unknown = JSON.parse(await readFile(path.join(REPO_ROOT, fx.rateCard), "utf8"));
  const fields = { ...fx.extracted, ...opts.overrideFields };
  const kernel = opts.kernel ?? (await loadKernel());
  const message = fx.conversation.filter((m) => m.from === "customer").map((m) => m.text).join("\n");

  const res = await handleEnquiry(
    { pool: opts.pool, kernel, notifier: opts.notifier ?? createLogNotifier() },
    {
      tenant: fx.tenant,
      threadId: `${fx.tenant.id}:thread:${fx.id}`,
      customerRef: fx.customerRef,
      rateCard,
      rateCardVersion: (rateCard as { version: number }).version,
      now: fx.now,
      availability: fx.availability,
      message,
      fields,
    },
  );
  return { reply: res.reply, quote: res.outcome, fields: fields as RunResult["fields"], ledgerRow: res.ledgerRow };
}
