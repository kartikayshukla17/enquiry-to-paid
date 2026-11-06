import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Outcome } from "../kernel/types.js";

export const AGENT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const REPO_ROOT = path.join(AGENT_ROOT, "..");
export const DEFAULT_SETS_DIR = path.join(AGENT_ROOT, "eval", "sets");
export const DEFAULT_RECORDINGS_DIR = path.join(AGENT_ROOT, "eval", "recordings");
export const DEFAULT_BASELINES_DIR = path.join(AGENT_ROOT, "eval", "baselines");
export const DEFAULT_RESULTS_PATH = path.join(AGENT_ROOT, "eval", "RESULTS.md");
/** Named fictional rate card every case is labelled against. */
export const RATE_CARD_PATH = "rate-cards/fictional-banquet.json";
/** Fixed scenario clock (not wall time) so runs are reproducible. */
export const EVAL_NOW = "2026-11-07T10:00:00Z";

export const FIELD_NAMES = ["service", "date", "guestCount", "locality", "language"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
export type Lang = "en" | "hinglish" | "hi";
export const LANGS: readonly Lang[] = ["en", "hinglish", "hi"];

export interface GoldFields {
  service: string | null;
  date: string | null;
  guestCount: number | null;
  locality: string | null;
  language: string;
}

export type GoldOutcome = { kind: "quote" } | { kind: "clarify" } | { kind: "refuse"; reason: string };

export interface EvalCase {
  id: string;
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

export async function loadRateCard(): Promise<unknown> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, RATE_CARD_PATH), "utf8"));
}

/** Pipeline outcome vocabulary: a missing-field refusal is a clarifying question, not a refusal. */
export function outcomeClass(o: Outcome): { kind: "quote" | "clarify" | "refuse"; reason?: string } {
  if (o.kind === "quote") return { kind: "quote" };
  if (o.reason === "missing_required_field") return { kind: "clarify" };
  return { kind: "refuse", reason: o.reason };
}
