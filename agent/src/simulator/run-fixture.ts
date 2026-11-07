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
import { DEMO_WEBHOOK_SECRET, razorpaySim } from "../payments/razorpay-sim.js";
import { handleWebhook, type WebhookResult } from "../payments/webhook.js";
import { createHmac } from "node:crypto";
import { composeNotifiers, createOwnerNotifier } from "../owner/notifier.js";
import { seedOwnerMembers } from "../owner/seed.js";
import { routeInbound, sendDailyDigest } from "../owner/inbound.js";
import { collectingChaserOutbox, type ChaserMessage } from "../chasers/types.js";

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
  /** `razorpay-sim`: quote replies carry a simulated payment link, and `{ pay: true }` steps deliver a signed paid webhook. */
  payments?: "razorpay-sim";
  /**
   * Owner channel (T17): members seeded with a hashed phone (FICTIONAL numbers, +91 00000 xxxxx). When present, refusal
   * escalations are also delivered to the owner and manager, and `owner` / `digest` steps are available.
   */
  owners?: { role: "owner" | "manager" | "staff"; phone: string }[];
  /** Chasers with consent (T19): quotes ask for opt-in and schedule 24h/72h reminders; `tick` steps send them into the collected chaser outbox. */
  chasers?: boolean;
}

/**
 * One step. A message may override `customerRef` (a different customer = a different thread) and `now` (the
 * injected clock for that step). `{ tick: true, now }` runs the due timers instead of sending a message.
 */
type NoStep = { tick?: undefined; killSwitch?: undefined; pay?: undefined; owner?: undefined; digest?: undefined };
type FixtureMessage =
  | (Omit<NoStep, "tick"> & { tick: true; now: string })
  | (Omit<NoStep, "killSwitch"> & { killSwitch: "on" | "off"; scope?: "tenant" | "global"; now: string })
  | (Omit<NoStep, "pay"> & { pay: true; now: string })
  /** A text from the sender with this phone: an owner/manager/staff member is routed to the owner channel, anyone else is a customer. */
  | (Omit<NoStep, "owner"> & { owner: string; text: string; now: string })
  | (Omit<NoStep, "digest"> & { digest: true; now: string })
  | (NoStep & { text: string; extracted?: Partial<ExtractedFields>; customerRef?: string; now?: string });

/** One line of the simulated owner WhatsApp thread, in order. */
export type OwnerLine =
  | { dir: "to_owner"; kind: "escalation" | "digest" | "customer_message" | "reply"; to: string; text: string; at: string }
  | { dir: "from_owner"; from: string; text: string; at: string }
  | { dir: "to_customer"; threadId: string; text: string; at: string };

export interface RunResult {
  reply: string;
  quote: TurnOutcome;
  fields: ExtractedFields & { date: string; guestCount: number };
  ledgerRow: LedgerRow;
  /** True when the thread is paused for the owner: the customer got no reply and the owner was shown the message. */
  held?: true;
  /** The text was a consent answer (T19: a "yes" to the opt-in question, or a stop word). */
  consent?: "granted" | "revoked";
  /** One entry per message processed, in order (the top-level fields describe the last). */
  turns: Omit<RunResult, "turns" | "ticks" | "payments" | "ownerTranscript">[];
  /** One entry per `tick` step: what the timer worker did at that clock. */
  ticks?: { at: string; processed: number; expiredHolds: string[]; chasersSent?: number }[];
  /** Every chaser the simulated WhatsApp outbox was handed, in order (only when the fixture sets `chasers`). */
  chasers?: ChaserMessage[];
  /** One entry per `pay` step: what the webhook handler did with the simulated signed paid event. */
  payments?: (WebhookResult | { status: "no_link" })[];
  /** The simulated owner thread (only when the fixture declares `owners`). */
  ownerTranscript?: OwnerLine[];
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

  const transcript: OwnerLine[] = [];
  if (fx.owners) await seedOwnerMembers(opts.pool, fx.tenant.id, fx.owners);
  const ownerOutbox = {
    send: (m: { role: string; kind: "escalation" | "digest" | "customer_message"; text: string; at: string }) => {
      transcript.push({ dir: "to_owner", kind: m.kind, to: m.role, text: m.text, at: m.at });
      return Promise.resolve();
    },
  };
  const payments = fx.payments === "razorpay-sim" ? razorpaySim({ webhookSecret: DEMO_WEBHOOK_SECRET }) : undefined;
  const paid: NonNullable<RunResult["payments"]> = [];
  const chaserSink: ChaserMessage[] = [];
  const chasers = fx.chasers ? ({ chasers: true } as const) : {};
  const turns: RunResult["turns"] = [];
  const ticks: NonNullable<RunResult["ticks"]> = [];
  const availability = fx.holds ? nativeAvailability : undefined;
  let llm = opts.llm;
  const customerTurn = async (c: { text: string; extracted?: Partial<ExtractedFields>; customerRef?: string; now?: string }): Promise<void> => {
    const customerRef = c.customerRef ?? fx.customerRef;
    const input = {
      tenant: fx.tenant,
      threadId: c.customerRef ? `${fx.tenant.id}:thread:${fx.id}:${c.customerRef}` : `${fx.tenant.id}:thread:${fx.id}`,
      customerRef,
      rateCard,
      now: c.now ?? fx.now,
      availability: fx.availability,
      message: c.text,
    };
    const base = opts.notifier ?? createLogNotifier();
    const notifier = fx.owners ? composeNotifiers(base, createOwnerNotifier({ pool: opts.pool, kernel, outbox: ownerOutbox })) : base;
    let res;
    if (c.extracted === undefined) {
      llm ??= createProvider();
      res = await handleMessage({ pool: opts.pool, kernel, notifier, ownerOutbox, llm, wordReplies: opts.wordReplies ?? process.env.LLM_WORD_REPLIES === "1", ...chasers, ...(availability && { availability }), ...(payments && { payments }) }, input);
    } else {
      res = await handleEnquiry({ pool: opts.pool, kernel, notifier, ownerOutbox, ...chasers, ...(availability && { availability }), ...(payments && { payments }) }, { ...input, fields: { ...c.extracted, ...opts.overrideFields } });
    }
    turns.push({ reply: res.reply, quote: res.outcome, fields: res.fields as RunResult["fields"], ledgerRow: res.ledgerRow, ...(res.held && { held: true as const }), ...(res.consent && { consent: res.consent }) });
  };
  for (const m of selected) {
    if (m.killSwitch) {
      // Tenant scope: flipped by the fixture tenant's seeded owner member. Global scope: by a fixture platform operator.
      const target = m.scope === "global" ? ({ kind: "global" } as const) : ({ kind: "tenant", tenantId: fx.tenant.id } as const);
      const actor = m.scope === "global" ? { operator: "fixture-operator" } : { memberId: legacyOwner(fx.tenant.id) };
      await setKillSwitch({ pool: opts.pool, kernel }, { target, on: m.killSwitch === "on", actor, now: m.now });
      continue;
    }
    if (m.pay) {
      // The simulated provider "pays" the tenant's newest unpaid link: a Razorpay-shaped event, signed with the demo secret.
      const row = (
        await opts.pool.query<{ tenant_id: string; provider_link_id: string; amount_minor: string; currency: string }>(
          `SELECT tenant_id, provider_link_id, amount_minor::text AS amount_minor, currency FROM payments
            WHERE tenant_id=$1 AND status='created' ORDER BY created_at DESC, quote_ledger_seq DESC LIMIT 1`,
          [fx.tenant.id],
        )
      ).rows[0];
      if (!payments || !row) {
        paid.push({ status: "no_link" });
        continue;
      }
      const amount = Number(row.amount_minor);
      const body = JSON.stringify({
        entity: "event",
        event: "payment_link.paid",
        payload: {
          payment_link: { entity: { id: row.provider_link_id, amount, currency: row.currency, notes: { tenant_id: row.tenant_id } } },
          payment: { entity: { id: `pay_sim_${paid.length + 1}`, amount, currency: row.currency } },
        },
      });
      const headers = { "x-razorpay-signature": createHmac("sha256", DEMO_WEBHOOK_SECRET).update(body).digest("hex"), "x-razorpay-event-id": `evt_sim_${fx.id}_${paid.length + 1}` };
      paid.push(await handleWebhook({ pool: opts.pool, kernel, payments }, body, headers, m.now));
      continue;
    }
    if (m.owner !== undefined) {
      transcript.push({ dir: "from_owner", from: m.owner, text: m.text, at: new Date(m.now).toISOString() });
      // Routed by hashed phone: a member goes to the owner channel and never reaches the customer pipeline; anyone else is a customer.
      const routed = await routeInbound({ pool: opts.pool, kernel }, { tenant: fx.tenant, senderRef: m.owner, text: m.text, now: m.now }, () =>
        customerTurn({ text: m.text, customerRef: m.owner, now: m.now, extracted: { language: "en", confidenceBps: 9000 } }),
      );
      if (routed.channel === "owner") {
        transcript.push({ dir: "to_owner", kind: "reply", to: m.owner, text: routed.result.reply, at: new Date(m.now).toISOString() });
        for (const cm of routed.result.customerMessages) transcript.push({ dir: "to_customer", threadId: cm.threadId, text: cm.text, at: new Date(m.now).toISOString() });
      }
      continue;
    }
    if (m.digest) {
      await sendDailyDigest({ pool: opts.pool, outbox: ownerOutbox, kernel }, { tenant: fx.tenant, now: m.now });
      continue;
    }
    if (m.tick) {
      const done = await runDueTimers(opts.pool, m.now, { kernel, ...(fx.chasers && { chaserOutbox: collectingChaserOutbox(chaserSink) }) });
      ticks.push({ at: new Date(m.now).toISOString(), processed: done.processed, expiredHolds: done.expiredHolds, ...(fx.chasers && { chasersSent: done.chasersSent.length }) });
      continue;
    }
    await customerTurn(m);
  }
  const last = turns[turns.length - 1] as Omit<RunResult, "turns" | "ticks" | "payments" | "ownerTranscript">;
  return { ...last, turns, ...(ticks.length > 0 && { ticks }), ...(paid.length > 0 && { payments: paid }), ...(fx.chasers && { chasers: chaserSink }), ...(fx.owners && { ownerTranscript: transcript }) };
}
