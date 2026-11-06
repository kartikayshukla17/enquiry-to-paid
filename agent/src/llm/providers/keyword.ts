/**
 * keyword-extractor-v0: a second, independent provider that proves the LlmProvider seam.
 * It shares no code with the fixture replay provider: it is a deliberately simple, rule-based extractor that
 * parses plain English and Latin-script Hinglish with regular expressions, offline, in-process (region "local").
 * It is NOT a language model and makes no claim to be one. It is gated like any other model before it can be enabled.
 */
import type { CallMeta, ExtractInput, ExtractResult, LlmProvider, WordReplyInput, WordReplyResult } from "../types.js";

export const KEYWORD_MODEL_ID = "keyword-extractor-v0";

const META: CallMeta = { modelId: KEYWORD_MODEL_ID, provider: "keyword", region: "local", usage: { tokens: 0, costMinor: 0 } };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const UNITS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, saat: 7, aath: 8, nau: 9,
};

function parseDate(t: string): string | null {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) return iso[0];
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\b/i.exec(t);
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i.exec(t);
  const [day, mon, year] = dm ? [dm[1]!, dm[2]!, dm[3]!] : md ? [md[2]!, md[1]!, md[3]!] : [];
  if (!day || !mon || !year) return null; // no year given: ambiguous, so say nothing rather than guess
  const d = Number(day);
  if (d < 1 || d > 31) return null;
  return `${year}-${String(MONTHS.indexOf(mon.toLowerCase().slice(0, 3)) + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseGuests(t: string): number | null {
  const digits = /\b(\d{1,4})\s*(?:\+\s*)?(?:guests?|log|people|persons?|pax|mehmaan|logon)\b/i.exec(t);
  if (digits) return Number(digits[1]);
  if (/\bdedh\s+sau\b/i.test(t)) return 150;
  if (/\bdhai\s+sau\b/i.test(t)) return 250;
  const words = /\b(ek|do|teen|chaar|char|paanch|panch|chhe|chhah|saat|aath|nau)\s+sau\b/i.exec(t);
  if (words) return UNITS[words[1]!.toLowerCase()]! * 100;
  const digitSau = /\b(\d{1,2})\s+sau\b/i.exec(t);
  if (digitSau) return Number(digitSau[1]) * 100;
  return null;
}

const HINGLISH = /\b(hai|hain|ko|chahiye|kitna|kitne|mein|ka|ki|ke|liye|sau|log|shaadi|sagai|agle|hafte|bhej|karo|aap|hum|honge)\b/i;

function intentOf(t: string): string {
  if (/\b(bot|robot|chatbot|human|insaan|asli)\b|\bai\b/i.test(t) && /\?|kya|are you|is this|am i/i.test(t)) return "asks_if_bot";
  if (/\b(package|bundle|combo)\b/i.test(t)) return "package_deal";
  if (/\b(match|cheaper|best price|last price|bargain|negotiat)/i.test(t) || /kam\s+kar/i.test(t)) return "negotiation";
  if (/\b(discount|offer|free|sasta|concession)\b|\d+\s*%/i.test(t)) return "discount_request";
  return "enquiry";
}

export function extractWithKeywords(text: string): Record<string, unknown> {
  const service = /\b(banquet|hall|party|wedding|shaadi|sagai|reception|birthday|engagement|venue)\b/i.test(text) ? "banquet" : null;
  const locality = /greater\s+noida\s+west/i.test(text) ? "greater-noida-west" : null;
  const date = parseDate(text);
  const guestCount = parseGuests(text);
  const language = /[ऀ-ॿ]/.test(text) ? "hi" : HINGLISH.test(text) ? "hinglish" : "en";
  const found = [service, date, guestCount, locality].filter((x) => x !== null).length;
  return {
    service,
    date,
    guestCount,
    locality,
    language,
    intent: intentOf(text),
    // Rules are certain about what they matched and know nothing else; a message that matched almost nothing is not trusted.
    confidenceBps: found >= 2 ? 8000 : 5000,
  };
}

export function createKeywordProvider(): LlmProvider {
  return {
    async extract(input: ExtractInput): Promise<ExtractResult> {
      return { ...META, fields: extractWithKeywords(input.text) };
    },
    /** Rule-based: no rewording. The template is the reply. */
    async wordReply(input: WordReplyInput): Promise<WordReplyResult> {
      return { ...META, text: input.template };
    },
  };
}
