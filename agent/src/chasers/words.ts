/**
 * What a short customer text means for consent. Pure string work, no model: a customer's "stop" must never depend on an LLM.
 *
 * Normalisation: NFKC (so full-width Latin and composed/decomposed Devanagari compare equal), lower case, zero-width
 * characters removed, every run of anything that is not a letter, mark or digit becomes one space (punctuation, emoji).
 */
export function normalizeText(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[​-‍⁠﻿]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((t) => t !== "");
}

/** Whole-message "yes" to the opt-in question: English, Hinglish, Devanagari. Nothing longer counts as an answer. */
const YES = ["yes", "y", "yep", "yeah", "haan", "han", "haa", "ha", "hanji", "haanji", "ji", "ji haan", "ji han", "हाँ", "हां", "हा", "जी", "जी हाँ", "जी हां", "हाँ जी", "हां जी"].map((p) => normalizeText(p).join(" "));

export type ConsentWord = "yes" | "stop";

const words = (list: string[]): string[][] => list.map((p) => normalizeText(p));

/**
 * Stop requests. Ruling: a message is a stop request when, after dropping leading filler words ("please", "ye", "message"...),
 * it BEGINS with one of these phrases and carries at most three more words ("stop messaging me", "mat bhejo please", "band karo ye messages").
 * A phrase in the middle of a sentence ("don't stop now") or a stop word followed by a real sentence ("Stop. Can we do the 20th instead?")
 * is conversation, not unsubscribe. "ruko" / "रुको" also mean "wait", so they count only as the whole message.
 */
const STOP_PHRASES = words([
  "stop", "unsubscribe", "unsub", "opt out", "optout",
  "band karo", "band kar do", "band kardo", "bandh karo", "bandh kar do", "mat bhejo", "mat bhejna", "mat bhejiye", "bas karo", "bas kar do",
  "बंद करो", "बंद कर दो", "बंद करिए", "बन्द करो", "बन्द कर दो", "मत भेजो", "मत भेजना", "मत भेजिए", "बस करो", "बस कर दो",
]);
const STOP_WHOLE_MESSAGE_ONLY = words(["ruko", "रुको"]);
const FILLERS = new Set(
  ["please", "plz", "pls", "kindly", "kripya", "kripaya", "कृपया", "ye", "yeh", "ये", "ab", "अब", "message", "messages", "msg", "msgs", "मैसेज", "मेसेज", "whatsapp", "व्हाट्सएप"].map((w) => normalizeText(w).join(" ")),
);
const MAX_WORDS_AFTER_STOP_PHRASE = 3;

const startsWith = (tokens: string[], phrase: string[]) => phrase.length > 0 && phrase.every((w, i) => tokens[i] === w);

function isStopRequest(text: string): boolean {
  let tokens = normalizeText(text);
  while (tokens.length > 0 && FILLERS.has(tokens[0]!) && tokens.length > 1) tokens = tokens.slice(1);
  if (STOP_WHOLE_MESSAGE_ONLY.some((p) => tokens.length === p.length && startsWith(tokens, p))) return true;
  return STOP_PHRASES.some((p) => startsWith(tokens, p) && tokens.length - p.length <= MAX_WORDS_AFTER_STOP_PHRASE);
}

export function classifyCustomerText(text: string): ConsentWord | undefined {
  if (isStopRequest(text)) return "stop";
  const t = normalizeText(text).join(" ");
  return YES.includes(t) ? "yes" : undefined;
}
