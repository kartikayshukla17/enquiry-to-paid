import type { ExtractedFields } from "../kernel/types.js";

export type ValidationResult = { ok: true; fields: ExtractedFields } | { ok: false; error: string };

const ALLOWED_KEYS = new Set(["service", "date", "guestCount", "locality", "language", "confidenceBps"]);
export const LANGUAGES = ["en", "hi", "hinglish"] as const;
const SLUG = /^[a-z][a-z0-9-]{0,47}$/; // short identifiers only; a sentence can never match

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Validates untrusted model output against ExtractedFields. Strict: unknown keys, wrong types and
 * free text are rejected. The result is rebuilt field by field (never spread), so nothing the model
 * invented can ride along into the kernel. `null` means "not stated" and is omitted.
 */
export function validateExtraction(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "not an object" };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS.has(k)) return { ok: false, error: `unknown key: ${k.slice(0, 32)}` };
  const has = (k: string) => Object.hasOwn(o, k) && o[k] !== null && o[k] !== undefined;

  const language = o.language;
  if (typeof language !== "string" || !(LANGUAGES as readonly string[]).includes(language)) return { ok: false, error: "language invalid" };
  const conf = o.confidenceBps;
  if (typeof conf !== "number" || !Number.isInteger(conf) || conf < 0 || conf > 10_000) {
    return { ok: false, error: "confidenceBps must be an integer in 0..10000" };
  }

  const out: ExtractedFields = { language, confidenceBps: conf };
  if (has("service")) {
    if (typeof o.service !== "string" || !SLUG.test(o.service)) return { ok: false, error: "service invalid" };
    out.service = o.service;
  }
  if (has("date")) {
    if (typeof o.date !== "string" || !validDate(o.date)) return { ok: false, error: "date invalid" };
    out.date = o.date;
  }
  if (has("guestCount")) {
    const g = o.guestCount;
    if (typeof g !== "number" || !Number.isInteger(g) || g < 1 || g > 100_000) return { ok: false, error: "guestCount invalid" };
    out.guestCount = g;
  }
  if (has("locality")) {
    if (typeof o.locality !== "string" || !SLUG.test(o.locality)) return { ok: false, error: "locality invalid" };
    out.locality = o.locality;
  }
  return { ok: true, fields: out };
}
