import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnOutcome } from "../kernel/types.js";

export const AGENT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const REPO_ROOT = path.join(AGENT_ROOT, "..");
export const DEFAULT_SETS_DIR = path.join(AGENT_ROOT, "eval", "sets");
export const DEFAULT_RECORDINGS_DIR = path.join(AGENT_ROOT, "eval", "recordings");
export const DEFAULT_BASELINES_DIR = path.join(AGENT_ROOT, "eval", "baselines");
export const DEFAULT_RESULTS_PATH = path.join(AGENT_ROOT, "eval", "RESULTS.md");
/** The card a case is labelled against when it names none (the original banquet set). */
export const DEFAULT_CARD_ID = "fictional-banquet";
/** Report order of the cards (data, not code: `eval/cards.json`). A card with no cases is simply absent from the report. */
export const CARDS_ORDER_PATH = path.join(AGENT_ROOT, "eval", "cards.json");
export async function loadCardOrder(): Promise<string[]> {
  return (JSON.parse(await readFile(CARDS_ORDER_PATH, "utf8")) as { order: string[] }).order;
}
export const rateCardPath = (cardId: string): string => `rate-cards/${cardId}.json`;
/** Fixed scenario clock (not wall time) so runs are reproducible. */
export const EVAL_NOW = "2026-11-07T10:00:00Z";

/** Fields the extraction is scored on. A case scores exactly the keys its `gold` object carries (null = "must be absent"). */
export const FIELD_NAMES = ["service", "date", "guestCount", "locality", "language", "package", "quantity", "hours", "distanceKm"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
export type Lang = "en" | "hinglish" | "hi";
export const LANGS: readonly Lang[] = ["en", "hinglish", "hi"];

export interface GoldFields {
  service?: string | null;
  date?: string | null;
  guestCount?: number | null;
  locality?: string | null;
  language: string;
  package?: string | null;
  quantity?: number | null;
  hours?: number | null;
  distanceKm?: number | null;
}

/** The scored fields of a case: the gold keys it carries. */
export const scoredFields = (c: { gold: GoldFields }): FieldName[] => FIELD_NAMES.filter((f) => Object.hasOwn(c.gold, f));

export type GoldOutcome = { kind: "quote" } | { kind: "clarify" } | { kind: "disclose" } | { kind: "refuse"; reason: string };

export interface EvalCase {
  id: string;
  /** Rate card id (file `rate-cards/<id>.json`); absent means the banquet card. */
  card?: string;
  lang: Lang;
  text: string;
  gold: GoldFields;
  outcome: GoldOutcome;
  blockedDates?: string[];
  note?: string;
}

export interface LoadedSets {
  cases: EvalCase[];
  /** sha256 of each set file's bytes, keyed by file name. */
  setHashes: Record<string, string>;
}

export const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

export async function loadSets(dir: string = DEFAULT_SETS_DIR): Promise<LoadedSets> {
  const cases: EvalCase[] = [];
  const setHashes: Record<string, string> = {};
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".jsonl")).sort()) {
    const raw = await readFile(path.join(dir, f));
    setHashes[f] = sha256(raw);
    for (const line of raw.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      cases.push(JSON.parse(line) as EvalCase);
    }
  }
  return { cases, setHashes };
}

export const cardOf = (c: { card?: string }): string => c.card ?? DEFAULT_CARD_ID;

export async function loadRateCard(cardId: string = DEFAULT_CARD_ID): Promise<unknown> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, rateCardPath(cardId)), "utf8"));
}

/** Pipeline outcome vocabulary: a missing-field refusal is a clarifying question, not a refusal. */
export function outcomeClass(o: TurnOutcome): { kind: "quote" | "clarify" | "refuse" | "disclose"; reason?: string } {
  if (o.kind === "disclosure") return { kind: "disclose" };
  if (o.kind === "quote") return { kind: "quote" };
  if (o.reason === "missing_required_field") return { kind: "clarify" };
  return { kind: "refuse", reason: o.reason };
}
