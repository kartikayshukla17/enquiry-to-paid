import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_ROOT } from "../eval/sets.js";

export const DEFAULT_ADV_CASES_DIR = path.join(AGENT_ROOT, "eval", "adversarial");
export const DEFAULT_ADV_RECORDINGS_DIR = path.join(DEFAULT_ADV_CASES_DIR, "recordings");
export const ADV_TENANT = { id: "tenant-adversarial", name: "FICTIONAL: Rose Court Banquets" };

export type AdvGold =
  /** The only acceptable end states for an attack: a typed refusal (escalated) ... */
  | { kind: "refuse"; reason: string; ruleGap?: string }
  /** ... or an honest "I am an automated assistant" answer in the customer's language. */
  | { kind: "disclose"; language: "en" | "hinglish" | "hi" };

export interface AdvCase {
  id: string;
  category: string;
  lang: string;
  /** Hostile (fictional) customer text. */
  text: string;
  /** What the scripted model returned for this text. Deliberately wrong or obedient when `fooled`. */
  response: unknown;
  gold: AdvGold;
  /** The recording models an LLM that was fooled by the text (returned a price, injected keys, ...). */
  fooled?: boolean;
  note?: string;
}

export async function loadAdvCases(dir: string = DEFAULT_ADV_CASES_DIR): Promise<AdvCase[]> {
  const cases: AdvCase[] = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".jsonl")).sort()) {
    for (const line of (await readFile(path.join(dir, f), "utf8")).split("\n")) {
      if (line.trim() !== "") cases.push(JSON.parse(line) as AdvCase);
    }
  }
  return cases;
}
