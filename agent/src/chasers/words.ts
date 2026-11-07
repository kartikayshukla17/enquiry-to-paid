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
const YES = ["yes", "y", "yep", "yeah", "haan", "han", "haa", "hanji", "haanji", "ji haan", "ji han", "हाँ", "हां", "हा", "जी हाँ", "जी हां", "हाँ जी", "हां जी"].map((p) => normalizeText(p).join(" "));

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

/**
 * Contains-anywhere pass: a missed stop is the dangerous side, so unambiguous stems count wherever they sit in the message.
 * Ruling: the only negation guard is on the "stop <verb>" stems, and it applies only when a negation attaches directly to "stop"
 * ("don't stop sending", "do not stop messaging", "never stop texting"). "unsubscribe", "opt out" and the Hinglish/Devanagari
 * request forms have NO guard: reading "I won't unsubscribe" as a stop is the safe direction. Stems that are a request
 * ("don't message me") need no guard either.
 */
const STEMS_UNGUARDED = words([
  "unsubscribe", "opt out", "optout", "stopall",
  "no more messages", "no more message", "i said stop", "bhejna band", "mat bhejo", "बंद करो", "बन्द करो", "मत भेजो", "भेजना बंद", "भेजना बन्द",
  ...["don t", "dont", "do not", "never"].flatMap((neg) => ["message", "contact", "text"].map((v) => `${neg} ${v} me`)),
]);
const STEMS_STOP_VERB = words(["sending", "messaging", "texting", "reminders", "bothering", "contacting"].map((w) => `stop ${w}`));
/** A negation attached to the token right before "stop": one token ("never", "dont", "cannot") or two ("don t", "do not", "can t"). */
const NEGATION_1 = new Set(["never", "dont", "cannot", "cant"]);
const NEGATION_2 = [["don", "t"], ["do", "not"], ["can", "t"], ["can", "not"]];
const negatedAt = (tokens: string[], i: number) =>
  (i >= 1 && NEGATION_1.has(tokens[i - 1]!)) || (i >= 2 && NEGATION_2.some(([a, b]) => tokens[i - 2] === a && tokens[i - 1] === b));
const containsAt = (tokens: string[], phrase: string[], from: number) => phrase.every((w, i) => tokens[from + i] === w);
const containsAnywhere = (tokens: string[], phrase: string[]) => tokens.some((_, i) => containsAt(tokens, phrase, i));
const containsStopVerb = (tokens: string[], phrase: string[]) => tokens.some((_, i) => containsAt(tokens, phrase, i) && !negatedAt(tokens, i));

/**
 * Clauses are cut on punctuation, dashes (em, en, spaced hyphen), slash and line breaks BEFORE punctuation is stripped,
 * so a negation never reaches across them ("Not interested. Unsubscribe me", "Not interested - stop messaging me").
 */
const CLAUSE_BREAK = /[.,;:!?\n\r\u2026\u0964\u0965|()[\]{}"\u201C\u201D\u2014\u2013/]+|\s[-\u2010\u2011\u2012]+\s/u;
const clausesOf = (text: string): string[][] =>
  text.normalize("NFKC").split(CLAUSE_BREAK).map(normalizeText).filter((t) => t.length > 0);

const startsWith = (tokens: string[], phrase: string[]) => phrase.length > 0 && phrase.every((w, i) => tokens[i] === w);

function isStopRequest(text: string): boolean {
  let tokens = normalizeText(text);
  while (tokens.length > 0 && FILLERS.has(tokens[0]!) && tokens.length > 1) tokens = tokens.slice(1);
  if (STOP_WHOLE_MESSAGE_ONLY.some((p) => tokens.length === p.length && startsWith(tokens, p))) return true;
  if (STOP_PHRASES.some((p) => startsWith(tokens, p) && tokens.length - p.length <= MAX_WORDS_AFTER_STOP_PHRASE)) return true;
  if (tokens.length === 1 && tokens[0] === "quit") return true;
  return clausesOf(text).some((clause) => STEMS_UNGUARDED.some((p) => containsAnywhere(clause, p)) || STEMS_STOP_VERB.some((p) => containsStopVerb(clause, p)));
}

export function classifyCustomerText(text: string): ConsentWord | undefined {
  if (isStopRequest(text)) return "stop";
  const t = normalizeText(text).join(" ");
  return YES.includes(t) ? "yes" : undefined;
}
