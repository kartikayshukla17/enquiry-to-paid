import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import { extractFields } from "../extract/extract.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import type { Outcome, Quote } from "../kernel/types.js";
import { createReplayProvider } from "../llm/fixture/index.js";
import type { LlmProvider } from "../llm/types.js";
import { EXTRACT_PROMPT_HASH, SCHEMA_VERSION } from "../llm/prompts.js";
import { handleMessage } from "../pipeline/handle-message.js";
import { DEFAULT_LOW_CONFIDENCE_BPS } from "../pipeline/handle-enquiry.js";
import { seedApprovedCard } from "../ratecard/legacy.js";
import {
  DEFAULT_RECORDINGS_DIR,
  DEFAULT_SETS_DIR,
  EVAL_NOW,
  FIELD_NAMES,
  LANGS,
  cardOf,
  loadCardOrder,
  loadRateCard,
  loadSets,
  outcomeClass,
  rateCardPath,
  scoredFields,
  sha256,
  type EvalCase,
  type FieldName,
  type Lang,
} from "./sets.js";

export const PROVENANCE_LABEL = "measured on fictional data; recorded-fixture provider, not a live model";
export const EVAL_MODEL_ID = "recorded-fixture-v1";
const TENANT = { id: "tenant-eval", name: "FICTIONAL: eval harness tenant" };

export interface ExtractionMetrics {
  fieldsCorrect: number;
  fieldsTotal: number;
  fieldAccuracyBps: number;
  /** Per field: cases where it was right / cases where gold scores it (a case scores the keys its gold carries). */
  perFieldCorrect: Record<FieldName, number>;
  perFieldTotal: Record<FieldName, number>;
  schemaValid: number;
  schemaValidBps: number;
  /** Mean confidenceBps over schema-valid extractions (integer, rounded). */
  meanConfidenceBps: number;
}

export interface PipelineMetrics {
  outcomeCorrect: number;
  outcomeAccuracyBps: number;
  /** Quotes issued where gold says clarify or refuse. The number that must be 0. */
  unsafeQuotes: number;
  unsafeCaseIds: string[];
  /** Gold says quote and a quote was issued, but at a different total than the gold fields give. */
  wrongPriceQuotes: number;
  wrongPriceCaseIds: string[];
  /** Gold says quote, none issued (safe, but a lost enquiry). */
  missedQuotes: number;
}

export interface LangMetrics {
  cases: number;
  extraction: ExtractionMetrics;
  pipeline: PipelineMetrics;
}

/** Per rate card: the pipeline metrics plus how much of the traffic the card priced versus refused. */
export interface CardMetrics extends LangMetrics {
  /** Pipeline outcomes actually produced. Clarifying questions and disclosures are neither quotes nor refusals. */
  quotes: number;
  refusals: number;
  clarifications: number;
  /** refusals / cases, integer basis points. */
  refusalShareBps: number;
  /** Cases the labels say the card should refuse, and the same share. */
  goldRefusals: number;
  goldRefusalShareBps: number;
  /** Quotes issued where gold says refuse:no_covering_rule. The number that must be 0 for every card. */
  outOfCoverageQuotes: number;
  outOfCoverageCaseIds: string[];
  /** Refusals with reason no_covering_rule, and how many of their escalations carried the card's suggested next step. */
  noCoveringRuleRefusals: number;
  suggestedEscalations: number;
}

export interface CaseResult {
  id: string;
  card: string;
  /** How many fields gold scores for this case (a schema-invalid read scores 0 of this). */
  scoredFieldCount: number;
  lang: Lang;
  text: string;
  schemaValid: boolean;
  confidenceBps: number | null;
  wrongFields: FieldName[];
  gold: string;
  got: string;
  outcomeOk: boolean;
  unsafe: boolean;
  wrongPrice: boolean;
}

export interface EvalReport {
  provenance: {
    label: string;
    modelId: string;
    provider: string;
    promptHash: string;
    promptHash8: string;
    schemaVersion: string;
    lowConfidenceBps: number;
    /** Every card that has cases, in CARD_IDS order. */
    rateCards: { path: string; id: string; hash: string }[];
    scenarioNow: string;
  };
  inputs: { caseCount: number; setHashes: Record<string, string>; recordingsHash: string };
  languages: Record<Lang, LangMetrics>;
  overall: LangMetrics;
  /** One engine, several cards: results split by rate card (keyed by card id, CARD_IDS order). */
  cards: Record<string, CardMetrics>;
  cases: CaseResult[];
}

export interface EvalOptions {
  pool: Pool;
  kernel?: KernelBridge;
  setsDir?: string;
  recordingsDir?: string;
  /** Candidate under test (default: replay of the eval recordings, labelled recorded-fixture-v1). */
  llm?: LlmProvider;
  /** Identity recorded in the report and the baseline file name; defaults to the recorded fixture. */
  candidate?: { provider: string; modelId: string; label?: string };
}

const bps = (num: number, den: number): number => (den === 0 ? 0 : Math.round((num * 10_000) / den));
const outcomeString = (c: { kind: string; reason?: string }): string => (c.kind === "refuse" ? `refuse:${c.reason}` : c.kind);

/** sha256 over every recording's name and bytes, in name order. Any edit to any recording changes it. */
export async function hashRecordings(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  const parts: string[] = [];
  for (const n of names) parts.push(`${n}:${sha256(await readFile(path.join(dir, n)))}`);
  return sha256(parts.join("\n"));
}

function summarise(results: { c: EvalCase; r: CaseResult; confidence: number | null }[]): LangMetrics {
  const perFieldCorrect = Object.fromEntries(FIELD_NAMES.map((f) => [f, 0])) as Record<FieldName, number>;
  const perFieldTotal = Object.fromEntries(FIELD_NAMES.map((f) => [f, 0])) as Record<FieldName, number>;
  let fieldsCorrect = 0;
  let fieldsTotal = 0;
  let schemaValid = 0;
  let confSum = 0;
  let outcomeCorrect = 0;
  let missedQuotes = 0;
  const unsafeCaseIds: string[] = [];
  const wrongPriceCaseIds: string[] = [];
  for (const { c, r, confidence } of results) {
    const scored = scoredFields(c);
    for (const f of scored) {
      perFieldTotal[f]++;
      if (!r.wrongFields.includes(f)) perFieldCorrect[f]++;
    }
    fieldsCorrect += scored.length - r.wrongFields.length;
    fieldsTotal += scored.length;
    if (r.schemaValid) {
      schemaValid++;
      confSum += confidence ?? 0;
    }
    if (r.outcomeOk) outcomeCorrect++;
    if (r.unsafe) unsafeCaseIds.push(r.id);
    if (r.wrongPrice) wrongPriceCaseIds.push(r.id);
    if (r.gold === "quote" && r.got !== "quote") missedQuotes++;
  }
  const n = results.length;
  return {
    cases: n,
    extraction: {
      fieldsCorrect,
      fieldsTotal,
      fieldAccuracyBps: bps(fieldsCorrect, fieldsTotal),
      perFieldCorrect,
      perFieldTotal,
      schemaValid,
      schemaValidBps: bps(schemaValid, n),
      meanConfidenceBps: schemaValid === 0 ? 0 : Math.round(confSum / schemaValid),
    },
    pipeline: {
      outcomeCorrect,
      outcomeAccuracyBps: bps(outcomeCorrect, n),
      unsafeQuotes: unsafeCaseIds.length,
      unsafeCaseIds,
      wrongPriceQuotes: wrongPriceCaseIds.length,
      wrongPriceCaseIds,
      missedQuotes,
    },
  };
}

/**
 * The seam behind `pnpm eval`: replays recorded extractions (offline) for every labelled case, scores the
 * extraction alone, then runs the full pipeline (extract -> schema -> confidence gate -> kernel) and scores the outcome.
 */
export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const kernel = opts.kernel ?? (await loadKernel());
  const recordingsDir = opts.recordingsDir ?? DEFAULT_RECORDINGS_DIR;
  const { cases, setHashes } = await loadSets(opts.setsDir ?? DEFAULT_SETS_DIR);
  const rateCards = new Map<string, unknown>();
  for (const id of new Set(cases.map(cardOf))) {
    const card = await loadRateCard(id);
    rateCards.set(id, card);
    // Setup only: each card goes through the real approval gate first; the pipeline never prices from an unapproved card.
    await seedApprovedCard({ pool: opts.pool, kernel }, { tenant: TENANT, card, now: EVAL_NOW });
  }
  const llm = opts.llm ?? createReplayProvider(recordingsDir);
  const events: EscalationEvent[] = [];
  const notifier = collectingNotifier(events);

  const evalGold = (c: EvalCase): Outcome => {
    const fields = Object.fromEntries(Object.entries(c.gold).filter(([, v]) => v !== null));
    return kernel.evaluate({
      rateCard: rateCards.get(cardOf(c)),
      fields: { ...fields, confidenceBps: 10_000 },
      availability: { blockedDates: c.blockedDates ?? [] },
      now: EVAL_NOW,
    }) as Outcome;
  };

  const results: { c: EvalCase; r: CaseResult; confidence: number | null; suggested: boolean }[] = [];
  for (const c of cases) {
    const rateCard = rateCards.get(cardOf(c));
    // (a) extraction alone
    const ext = await extractFields(llm, c.text);
    const wrongFields = scoredFields(c).filter((f) => !ext.ok || (ext.fields[f] ?? null) !== (c.gold[f] ?? null));
    // (b) full pipeline
    const eventsBefore = events.length;
    const res = await handleMessage(
      { pool: opts.pool, kernel, notifier, llm, lowConfidenceBps: DEFAULT_LOW_CONFIDENCE_BPS },
      {
        tenant: TENANT,
        threadId: `${TENANT.id}:thread:${c.id}`,
        customerRef: `eval-${c.id}`,
        rateCard,
        now: EVAL_NOW,
        availability: { blockedDates: c.blockedDates ?? [] },
        message: c.text,
      },
    );
    const got = outcomeClass(res.outcome);
    const gold = c.outcome;
    const goldStr = outcomeString(gold);
    const gotStr = outcomeString(got);
    const goldOut = evalGold(c);
    const wrongPrice =
      res.outcome.kind === "quote" && goldOut.kind === "quote" && (res.outcome as Quote).total !== (goldOut as Quote).total;
    results.push({
      c,
      suggested: events.slice(eventsBefore).some((e) => e.suggestion !== undefined),
      confidence: ext.ok ? ext.fields.confidenceBps : null,
      r: {
        id: c.id,
        card: cardOf(c),
        scoredFieldCount: scoredFields(c).length,
        lang: c.lang,
        text: c.text,
        schemaValid: ext.ok,
        confidenceBps: ext.ok ? ext.fields.confidenceBps : null,
        wrongFields,
        gold: goldStr,
        got: gotStr,
        outcomeOk: goldStr === gotStr,
        unsafe: got.kind === "quote" && gold.kind !== "quote",
        wrongPrice,
      },
    });
  }

  const languages = Object.fromEntries(
    LANGS.map((l) => [l, summarise(results.filter((x) => x.c.lang === l))]),
  ) as Record<Lang, LangMetrics>;
  const order = await loadCardOrder();
  const unlisted = [...rateCards.keys()].filter((id) => !order.includes(id));
  if (unlisted.length) throw new Error(`cards with eval cases but not listed in eval/cards.json: ${unlisted.join(", ")}`);
  const cardIds = order.filter((id) => rateCards.has(id));
  const cards = Object.fromEntries(
    cardIds.map((id) => {
      const rows = results.filter((x) => cardOf(x.c) === id);
      const got = rows.map((x) => x.r.got);
      const goldRefusals = rows.filter((x) => x.r.gold.startsWith("refuse:")).length;
      const outOfCoverage = rows.filter((x) => x.r.got === "quote" && x.c.outcome.kind === "refuse" && x.c.outcome.reason === "no_covering_rule").map((x) => x.r.id);
      const refusals = got.filter((g) => g.startsWith("refuse:")).length;
      const m: CardMetrics = {
        ...summarise(rows),
        quotes: got.filter((g) => g === "quote").length,
        refusals,
        clarifications: got.filter((g) => g === "clarify").length,
        refusalShareBps: bps(refusals, rows.length),
        goldRefusals,
        goldRefusalShareBps: bps(goldRefusals, rows.length),
        outOfCoverageQuotes: outOfCoverage.length,
        outOfCoverageCaseIds: outOfCoverage,
        noCoveringRuleRefusals: got.filter((g) => g === "refuse:no_covering_rule").length,
        suggestedEscalations: rows.filter((x) => x.suggested).length,
      };
      return [id, m];
    }),
  ) as Record<string, CardMetrics>;
  return {
    provenance: {
      label: opts.candidate?.label ?? PROVENANCE_LABEL,
      modelId: opts.candidate?.modelId ?? EVAL_MODEL_ID,
      provider: opts.candidate?.provider ?? "fixture",
      promptHash: EXTRACT_PROMPT_HASH,
      promptHash8: EXTRACT_PROMPT_HASH.slice(0, 8),
      schemaVersion: SCHEMA_VERSION,
      lowConfidenceBps: DEFAULT_LOW_CONFIDENCE_BPS,
      rateCards: cardIds.map((id) => ({ path: rateCardPath(id), id, hash: kernel.rateCardHash(rateCards.get(id)) })),
      scenarioNow: EVAL_NOW,
    },
    inputs: { caseCount: cases.length, setHashes, recordingsHash: await hashRecordings(recordingsDir) },
    languages,
    overall: summarise(results),
    cards,
    cases: results.map((x) => x.r),
  };
}
