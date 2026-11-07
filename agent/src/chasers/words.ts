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

export type ConsentWord = "yes";

export function classifyCustomerText(text: string): ConsentWord | undefined {
  const t = normalizeText(text).join(" ");
  return YES.includes(t) ? "yes" : undefined;
}
