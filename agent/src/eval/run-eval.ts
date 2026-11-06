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
import {
  DEFAULT_RECORDINGS_DIR,
  DEFAULT_SETS_DIR,
  EVAL_NOW,
  FIELD_NAMES,
  LANGS,
  RATE_CARD_PATH,
  loadRateCard,
  loadSets,
  outcomeClass,
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
  perFieldCorrect: Record<FieldName, number>;
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

export interface CaseResult {
  id: string;
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
    rateCard: { path: string; id: string; hash: string };
    scenarioNow: string;
  };
  inputs: { caseCount: number; setHashes: Record<string, string>; recordingsHash: string };
  languages: Record<Lang, LangMetrics>;
  overall: LangMetrics;
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
  let fieldsCorrect = 0;
  let schemaValid = 0;
  let confSum = 0;
  let outcomeCorrect = 0;
  let missedQuotes = 0;
  const unsafeCaseIds: string[] = [];
  const wrongPriceCaseIds: string[] = [];
  for (const { r, confidence } of results) {
    for (const f of FIELD_NAMES) if (!r.wrongFields.includes(f)) perFieldCorrect[f]++;
    fieldsCorrect += FIELD_NAMES.length - r.wrongFields.length;
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
      fieldsTotal: n * FIELD_NAMES.length,
      fieldAccuracyBps: bps(fieldsCorrect, n * FIELD_NAMES.length),
      perFieldCorrect,
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
  const rateCard = await loadRateCard();
  const llm = opts.llm ?? createReplayProvider(recordingsDir);
  const events: EscalationEvent[] = [];
  const notifier = collectingNotifier(events);

  const evalGold = (c: EvalCase): Outcome => {
    const fields = Object.fromEntries(Object.entries(c.gold).filter(([, v]) => v !== null));
    return kernel.evaluate({
      rateCard,
      fields: { ...fields, confidenceBps: 10_000 },
      availability: { blockedDates: c.blockedDates ?? [] },
      now: EVAL_NOW,
    }) as Outcome;
  };

  const results: { c: EvalCase; r: CaseResult; confidence: number | null }[] = [];
  for (const c of cases) {
    // (a) extraction alone
    const ext = await extractFields(llm, c.text);
    const wrongFields = FIELD_NAMES.filter((f) => !ext.ok || (ext.fields[f] ?? null) !== c.gold[f]);
    // (b) full pipeline
    const res = await handleMessage(
      { pool: opts.pool, kernel, notifier, llm, lowConfidenceBps: DEFAULT_LOW_CONFIDENCE_BPS },
      {
        tenant: TENANT,
        threadId: `${TENANT.id}:thread:${c.id}`,
        customerRef: `eval-${c.id}`,
        rateCard,
        rateCardVersion: (rateCard as { version: number }).version,
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
      confidence: ext.ok ? ext.fields.confidenceBps : null,
      r: {
        id: c.id,
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
  const card = rateCard as { id: string };
  return {
    provenance: {
      label: opts.candidate?.label ?? PROVENANCE_LABEL,
      modelId: opts.candidate?.modelId ?? EVAL_MODEL_ID,
      provider: opts.candidate?.provider ?? "fixture",
      promptHash: EXTRACT_PROMPT_HASH,
      promptHash8: EXTRACT_PROMPT_HASH.slice(0, 8),
      schemaVersion: SCHEMA_VERSION,
      lowConfidenceBps: DEFAULT_LOW_CONFIDENCE_BPS,
      rateCard: { path: RATE_CARD_PATH, id: card.id, hash: kernel.rateCardHash(rateCard) },
      scenarioNow: EVAL_NOW,
    },
    inputs: { caseCount: cases.length, setHashes, recordingsHash: await hashRecordings(recordingsDir) },
    languages,
    overall: summarise(results),
    cases: results.map((x) => x.r),
  };
}
