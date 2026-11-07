import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import type { Availability, ExtractedFields, TurnOutcome } from "../kernel/types.js";
import type { LedgerRow } from "../ledger/index.js";
import { createLogNotifier, type Notifier } from "../escalation/index.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { handleMessage } from "../pipeline/handle-message.js";
import { createProvider } from "../llm/config.js";
import type { LlmProvider } from "../llm/types.js";
import { nativeAvailability } from "../availability/native.js";
import { runDueTimers } from "../timers/run.js";
import { seedApprovedCard } from "../ratecard/legacy.js";
import { loadCardSource } from "../ratecard/source.js";
import { publishDraft } from "../ratecard/store.js";
import { legacyOwner } from "../ratecard/legacy.js";
import { setKillSwitch } from "../killswitch/index.js";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const AGENT_ROOT = path.join(REPO_ROOT, "agent");

interface Fixture {
  id: string;
  tenant: { id: string; name: string };
  rateCard: string; // path relative to repo root: a `.json` card or a CSV template directory
  /**
   * `approved` (default): the card goes through the real approval gate (read-backs, all yes, by a seeded owner) before
   * the first message. `unapproved`: it is only stored as a draft revision, so it must not quote.
   */
  cardApproval?: "approved" | "unapproved";
  now: string;
  customerRef: string;
  availability: Availability;
  /** Single-message form (T1). */
  conversation?: { from: string; text: string }[];
  extracted?: ExtractedFields;
  /** Multi-message form (T3): per-message fixture-extracted fields, merged over earlier ones by the thread. */
  /** `extracted` omitted: the text goes through the LlmProvider (replay by default, offline). */
  messages?: FixtureMessage[];
  /** Use the native Postgres availability provider: quotes place a 48h hold and taken dates refuse. */
  holds?: boolean;
}

/**
 * One step. A message may override `customerRef` (a different customer = a different thread) and `now` (the
 * injected clock for that step). `{ tick: true, now }` runs the due timers instead of sending a message.
 */
type FixtureMessage =
  | { tick: true; now: string; killSwitch?: undefined }
  | { killSwitch: "on" | "off"; scope?: "tenant" | "global"; now: string; tick?: undefined }
  | { killSwitch?: undefined; tick?: false; text: string; extracted?: Partial<ExtractedFields>; customerRef?: string; now?: string };

export interface RunResult {
  reply: string;
  quote: TurnOutcome;
  fields: ExtractedFields & { date: string; guestCount: number };
  ledgerRow: LedgerRow;
  /** One entry per message processed, in order (the top-level fields describe the last). */
  turns: Omit<RunResult, "turns" | "ticks">[];
  /** One entry per `tick` step: what the timer worker did at that clock. */
  ticks?: { at: string; processed: number; expiredHolds: string[] }[];
}

export interface RunOptions {
  pool: Pool;
  kernel?: KernelBridge;
  /** Escalation sink; defaults to the logging stub. */
  notifier?: Notifier;
  /** Test hook: replace some extracted fields (still typed). */
  overrideFields?: Partial<ExtractedFields>;
  /** Process only the message at this index (0-based); lets a test use a fresh connection per message. */
  only?: number;
  /** Provider for messages without fixture-extracted fields; defaults to createProvider() from env (replay). */
  llm?: LlmProvider;
  /** Let the model reword quote/clarify replies (code injects and checks the numbers). Default: LLM_WORD_REPLIES=1. */
  wordReplies?: boolean;
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
  const kernel = opts.kernel ?? (await loadKernel());
  const rateCard = await loadCardSource(fx.rateCard, kernel);
  const gateDeps = { pool: opts.pool, kernel };
  if (fx.cardApproval === "unapproved") await publishDraft(gateDeps, { tenant: fx.tenant, card: rateCard as Record<string, unknown>, source: fx.rateCard });
  else await seedApprovedCard(gateDeps, { tenant: fx.tenant, card: rateCard, now: fx.now, source: fx.rateCard });
  const messages =
    fx.messages ??
    [
      {
        text: (fx.conversation ?? []).filter((m) => m.from === "customer").map((m) => m.text).join("\n"),
        extracted: fx.extracted ?? {},
      },
    ];
  const selected = opts.only === undefined ? messages : [messages[opts.only]].filter((m) => m !== undefined);
  if (selected.length === 0) throw new Error(`fixture ${fx.id} has no message ${opts.only}`);

  const turns: RunResult["turns"] = [];
  const ticks: NonNullable<RunResult["ticks"]> = [];
  const availability = fx.holds ? nativeAvailability : undefined;
  let llm = opts.llm;
  for (const m of selected) {
    if (m.killSwitch) {
      // Tenant scope: flipped by the fixture tenant's seeded owner member. Global scope: by a fixture platform operator.
      const target = m.scope === "global" ? ({ kind: "global" } as const) : ({ kind: "tenant", tenantId: fx.tenant.id } as const);
      const actor = m.scope === "global" ? { operator: "fixture-operator" } : { memberId: legacyOwner(fx.tenant.id) };
      await setKillSwitch({ pool: opts.pool, kernel }, { target, on: m.killSwitch === "on", actor, now: m.now });
      continue;
    }
    if (m.tick) {
      const done = await runDueTimers(opts.pool, m.now, { kernel });
      ticks.push({ at: new Date(m.now).toISOString(), processed: done.processed, expiredHolds: done.expiredHolds });
      continue;
    }
    const customerRef = m.customerRef ?? fx.customerRef;
    const input = {
      tenant: fx.tenant,
      threadId: m.customerRef ? `${fx.tenant.id}:thread:${fx.id}:${m.customerRef}` : `${fx.tenant.id}:thread:${fx.id}`,
      customerRef,
      rateCard,
      now: m.now ?? fx.now,
      availability: fx.availability,
      message: m.text,
    };
    const notifier = opts.notifier ?? createLogNotifier();
    let res;
    if (m.extracted === undefined) {
      llm ??= createProvider();
      res = await handleMessage({ pool: opts.pool, kernel, notifier, llm, wordReplies: opts.wordReplies ?? process.env.LLM_WORD_REPLIES === "1", ...(availability && { availability }) }, input);
    } else {
      res = await handleEnquiry({ pool: opts.pool, kernel, notifier, ...(availability && { availability }) }, { ...input, fields: { ...m.extracted, ...opts.overrideFields } });
    }
    turns.push({ reply: res.reply, quote: res.outcome, fields: res.fields as RunResult["fields"], ledgerRow: res.ledgerRow });
  }
  const last = turns[turns.length - 1] as Omit<RunResult, "turns" | "ticks">;
  return { ...last, turns, ...(ticks.length > 0 && { ticks }) };
}
