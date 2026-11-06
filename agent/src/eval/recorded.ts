/**
 * What the recorded-fixture provider is scripted to have answered for each eval case.
 *
 * HONESTY: these are HAND-SEEDED, FICTIONAL recordings, not output from any live model. Every case defaults to
 * "the model returned the gold fields at flat 9000 bps confidence"; the entries in MISTAKES are deliberate,
 * realistic extraction errors so the harness has something to catch. Because the mistakes are chosen by hand,
 * the resulting numbers check the harness and the pipeline's safety gates. They are NOT a measurement of any
 * model's accuracy in any language.
 */
import type { EvalCase } from "./sets.js";

export const DEFAULT_CONFIDENCE_BPS = 9000;

export type RawResponse = Record<string, unknown>;

/** Replaces the default response entirely (must restate every key it wants the model to have returned). */
export const MISTAKES: Record<string, { why: string; response: RawResponse }> = {
  "en-02": {
    why: "reads '60 guests' as 80 (a plausible digit slip; still inside the card, so it prices wrongly)",
    response: { service: "banquet", date: "2026-12-15", guestCount: 80, locality: null, language: "en", confidenceBps: 8800 },
  },
  "en-09": {
    why: "invents a concrete date for 'next Friday' and is fairly sure of it",
    response: { service: "banquet", date: "2026-11-13", guestCount: 70, locality: null, language: "en", confidenceBps: 8200 },
  },
  "en-10": {
    why: "picks a midpoint of the range but is unsure (below the confidence gate)",
    response: { service: "banquet", date: null, guestCount: 125, locality: null, language: "en", confidenceBps: 6200 },
  },
  "en-15": {
    why: "returns the neighbourhood slug instead of the locality the card uses",
    response: { service: "banquet", date: "2026-11-28", guestCount: 90, locality: "gaur-city", language: "en", confidenceBps: 9000 },
  },
  "en-16": {
    why: "leaves the number as a word, which the strict schema rejects",
    response: { service: "banquet", date: "2026-12-05", guestCount: "forty", locality: null, language: "en", confidenceBps: 9000 },
  },
  "en-17": {
    why: "fills a year the customer never gave (a past one)",
    response: { service: "banquet", date: "2026-01-03", guestCount: 150, locality: null, language: "en", confidenceBps: 8000 },
  },
  "hg-02": {
    why: "reads 'do sau' as 2 and drops 'sau'",
    response: { service: "banquet", date: "2026-12-19", guestCount: 2, locality: null, language: "hinglish", confidenceBps: 8800 },
  },
  "hg-03": {
    why: "picks the wrong year for 'Shaadi 12 Dec ko' (no year given)",
    response: { service: "banquet", date: "2025-12-12", guestCount: 150, locality: null, language: "hinglish", confidenceBps: 8400 },
  },
  "hg-04": {
    why: "invents a date for 'agle hafte Saturday'",
    response: { service: "banquet", date: "2026-11-14", guestCount: 80, locality: null, language: "hinglish", confidenceBps: 7800 },
  },
  "hg-05": {
    why: "reads the ambiguous '10-11-12' as 10 November 2012",
    response: { service: "banquet", date: "2012-11-10", guestCount: 60, locality: null, language: "hinglish", confidenceBps: 7500 },
  },
  "hg-16": {
    why: "drops the leading digit of the day ('14 November' read as 4 November, which is already past)",
    response: { service: "banquet", date: "2026-11-04", guestCount: 45, locality: null, language: "hinglish", confidenceBps: 8900 },
  },
  "hg-09": {
    why: "reads 'teen sau pachaas' as 305 (still over the card's maximum)",
    response: { service: "banquet", date: "2026-11-28", guestCount: 305, locality: null, language: "hinglish", confidenceBps: 8600 },
  },
  "hg-11": {
    why: "labels a Hinglish message as English",
    response: { service: "banquet", date: "2027-01-02", guestCount: 80, locality: "greater-noida-west", language: "en", confidenceBps: 8700 },
  },
  "hg-12": {
    why: "returns 'dedh sau' as 1.5, which the strict schema rejects",
    response: { service: "banquet", date: "2026-12-05", guestCount: 1.5, locality: null, language: "hinglish", confidenceBps: 8500 },
  },
  "hg-13": {
    why: "guesses a range midpoint but is unsure (below the confidence gate)",
    response: { service: "banquet", date: null, guestCount: 125, locality: null, language: "hinglish", confidenceBps: 5200 },
  },
  "hd-02": {
    why: "labels a Devanagari message as hinglish",
    response: { service: "banquet", date: "2026-12-15", guestCount: 60, locality: null, language: "hinglish", confidenceBps: 8600 },
  },
  "hd-03": {
    why: "reads 'डेढ़ सौ' as 100",
    response: { service: "banquet", date: null, guestCount: 100, locality: null, language: "hi", confidenceBps: 8300 },
  },
  "ph-en-07": {
    why: "reads '40 km' as 4 km (a digit slip that lands in the free travel band, so the quote under-prices)",
    response: { service: "wedding-shoot", date: "2026-12-20", package: "standard", hours: 8, distanceKm: 4, language: "en", confidenceBps: 8700 },
  },
  "ph-hg-06": {
    why: "reads 'pachaas' (50) as 15, which is also a valid distance but a cheaper travel band",
    response: { service: "wedding-shoot", date: "2026-12-09", package: "standard", hours: 6, distanceKm: 15, language: "hinglish", confidenceBps: 8300 },
  },
  "ph-hg-07": {
    why: "guesses a service from a vague message but is unsure (below the confidence gate)",
    response: { service: "wedding-shoot", date: null, language: "hinglish", confidenceBps: 5400 },
  },
  "b2b-en-08": {
    why: "reads 5000 as 500 (dropped zero), which lands in a dearer unit-price band",
    response: { service: "nylon-ties", quantity: 500, language: "en", confidenceBps: 8700 },
  },
  "b2b-hg-02": {
    why: "reads 'do hazaar' as 2 and drops 'hazaar', which is below the bolts minimum",
    response: { service: "steel-bolts", quantity: 2, language: "hinglish", confidenceBps: 8600 },
  },
  "b2b-hg-07": {
    why: "reads 'paanch sau' as 5; the ties minimum raises it to 500, so the quote is still right",
    response: { service: "nylon-ties", quantity: 5, language: "hinglish", confidenceBps: 8400 },
  },
  "b2b-hg-08": {
    why: "guesses a product from a vague message but is unsure (below the confidence gate)",
    response: { service: "steel-bolts", language: "hinglish", confidenceBps: 5200 },
  },
};

/** The raw JSON the scripted model returns for a case. */
export function recordedResponse(c: EvalCase): RawResponse {
  const m = MISTAKES[c.id];
  if (m) return m.response;
  return { ...c.gold, confidenceBps: DEFAULT_CONFIDENCE_BPS, intent: "enquiry" };
}
