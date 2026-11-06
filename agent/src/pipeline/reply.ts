import { assertNever, type ExtractedFields, type Outcome, type Quote, type RefusalReason } from "../kernel/types.js";

const SYMBOLS: Record<string, string> = { INR: "₹" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Indian digit grouping (3,2,2...) of a non-negative integer string. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${digits.slice(-3)}`;
}

/** Formats integer minor units (1/100 major) for display. Pure string work on integers. */
export function formatMoney(minor: number, currency: string): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const major = Math.trunc(abs / 100);
  const cents = abs % 100;
  const grouped = currency === "INR" ? groupIndian(String(major)) : String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = cents === 0 ? "" : `.${String(cents).padStart(2, "0")}`;
  return `${sign}${SYMBOLS[currency] ?? `${currency} `}${grouped}${frac}`;
}

/** `YYYY-MM-DD[...]` to `D Mon YYYY`. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export interface ReplyTemplate {
  kind: "quote" | "clarify";
  /** Wording with `{{placeholders}}`; contains no digits. */
  template: string;
  /** Placeholder values, all formatted from kernel output or typed fields. */
  values: Record<string, string>;
}

/** Fills `{{name}}` placeholders; the only way a number enters a reply. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => values[k] ?? "");
}

/** Extra facts a reply may state besides the kernel outcome. Each is formatted from typed data, never from model text. */
export interface ReplyContext {
  /** The date is held for this customer until this (already formatted, tenant timezone). */
  holdUntil?: string;
}

const TZ_LABELS: Record<string, string> = { "Asia/Kolkata": "IST", "Asia/Dubai": "GST", UTC: "UTC" };

/** `9 Nov 2026, 3:30 pm IST`: an instant shown in the tenant's timezone. Pure; the instant is passed in. */
export function formatInstantInZone(iso: string, timeZone: string): string {
  const at = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const h = get("hour");
  const min = String(get("minute")).padStart(2, "0");
  const offset = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  const label = TZ_LABELS[timeZone] ?? offset.replace("GMT", "UTC");
  return `${get("day")} ${MONTHS[get("month") - 1]} ${get("year")}, ${h % 12 === 0 ? 12 : h % 12}:${min} ${h < 12 ? "am" : "pm"} ${label}`;
}

function quoteTemplate(q: Quote, f: ExtractedFields, ctx: ReplyContext = {}): ReplyTemplate {
  const hasEcho = f.guestCount !== undefined && f.date;
  // The quantity actually priced: a card floor may have raised what the customer asked for.
  const adjustments = q.adjustments ?? [];
  const quoted = adjustments.find((a) => a.field === "quantity")?.to ?? f.quantity;
  const hasQuantity = !hasEcho && quoted !== undefined;
  const intro = hasEcho
    ? "Thank you for your enquiry! Here is your quote for {{guestCount}} guests on {{date}}:"
    : hasQuantity
      ? "Thank you for your enquiry! Here is your quote for {{quantity}} units:"
      : "Thank you for your enquiry! Here is your quote:";
  return {
    kind: "quote",
    template: [
      intro, "", "{{lines}}", "", ...(adjustments.length > 0 ? ["{{notes}}", ""] : []), "Total: {{total}}", "This quote is valid until {{validUntil}}.",
      ...(ctx.holdUntil !== undefined ? ["Your date is held for you until {{holdUntil}}."] : []),
    ].join("\n"),
    values: {
      ...(hasEcho && { guestCount: String(f.guestCount), date: formatDate(f.date as string) }),
      ...(hasQuantity && { quantity: String(quoted) }),
      ...(adjustments.length > 0 && {
        notes: adjustments.map((a) => `${a.label} applies, so this quote is for ${a.to} instead of the ${a.from} you asked for.`).join("\n"),
      }),
      lines: q.lines.map((l) => `- ${l.label}: ${formatMoney(l.amount, q.currency)}`).join("\n"),
      total: formatMoney(q.total, q.currency),
      validUntil: formatDate(q.validUntil),
      ...(ctx.holdUntil !== undefined && { holdUntil: ctx.holdUntil }),
    },
  };
}

/** The template behind a reply that may be LLM-worded (quote, clarifying question); undefined for holding replies. */
export function replyTemplate(outcome: Outcome, fields: ExtractedFields, rateCard?: unknown, ctx: ReplyContext = {}): ReplyTemplate | undefined {
  if (outcome.kind === "quote") return quoteTemplate(outcome, fields, ctx);
  if (outcome.reason === "missing_required_field") {
    const q = clarifyingQuestion(outcome.ruleGap, rateCard);
    if (q !== undefined) return { kind: "clarify", template: "Thank you for your enquiry! {{question}}", values: { question: q } };
  }
  return undefined;
}

/**
 * Builds the customer-facing reply. Every number comes from the kernel outcome
 * (or the typed fields it priced); there is no free-text number path.
 */
export function renderReply(outcome: Outcome, fields: ExtractedFields, rateCard?: unknown, ctx: ReplyContext = {}): string {
  const t = replyTemplate(outcome, fields, rateCard, ctx);
  if (t) return fillTemplate(t.template, t.values);
  if (outcome.kind === "refusal") return holdingReply(outcome.reason);
  throw new Error("unreachable");
}

/**
 * Safe holding reply for a refusal: no prices, no numbers, no promises, and it never reveals
 * the card's internals. Static text, so no digit can appear.
 */
export function holdingReply(reason: RefusalReason): string {
  switch (reason) {
    case "discount_request":
      return "Thank you for asking! I am not able to change or negotiate prices, so I have passed your request to the owner. They will get back to you shortly.";
    case "no_covering_rule":
    case "out_of_policy":
    case "low_confidence":
    case "missing_required_field":
    case "calendar_mismatch":
      return "Thank you for your enquiry! This one needs a personal look from our team, so I have passed it to them. They will get back to you shortly with the details.";
    case "date_unavailable":
      return "Thank you for your enquiry! I am not able to confirm that date right now, so I have passed it to our team. They will get back to you shortly with options.";
    default:
      return assertNever(reason);
  }
}

/**
 * The customer asked for a date that is taken. Specific about the date (the one number it states is the date they
 * gave); alternatives are dates only, never prices, and only when the card allows them.
 */
export function unavailableReply(date: string, alternatives: string[] = []): string {
  const head = `Thank you for your enquiry! Unfortunately ${formatDate(date)} is not available.`;
  const alt =
    alternatives.length > 0
      ? ` These nearby dates are free: ${alternatives.map(formatDate).join(", ")}. Tell me if one of them works.`
      : " I have let our team know in case anything changes.";
  return head + alt;
}

/** Said when the customer comes back to a quote whose validity has passed: it is not honoured, it is re-checked. */
export const EXPIRED_QUOTE_PREFIX = "Your earlier quote has expired, so I have checked our current rates and availability again. ";

/**
 * The question for the one field the kernel named (`ruleGap`), taken verbatim from the card's
 * `requiredFields`. Returns undefined when the card has no such entry (never invents a question).
 */
export function clarifyingQuestion(field: string | undefined, rateCard: unknown): string | undefined {
  const required = (rateCard as { requiredFields?: { field: string; question: string }[] } | undefined)?.requiredFields;
  return required?.find((r) => r.field === field)?.question;
}

/**
 * Honest answer to "are you a bot?": static text per language (no model wording, no digits, no price),
 * naming the business and offering a human. Devanagari customers get Devanagari, Hinglish customers Latin-script Hinglish.
 */
export function disclosureReply(language: string, businessName: string): string {
  switch (language) {
    case "hinglish":
      return `Ji, main ${businessName} ka automated assistant hoon, koi insaan nahi. Main rate card ke hisaab se aapki madad kar sakta hoon, aur agar aap chahein to main owner ko baat karne ke liye bula sakta hoon. Bas bol dijiye.`;
    case "hi":
      return `जी, मैं ${businessName} का ऑटोमेटेड असिस्टेंट हूँ, कोई इंसान नहीं। मैं रेट कार्ड के हिसाब से आपकी मदद कर सकता हूँ, और आप चाहें तो मैं ओनर को बात करने के लिए बुला सकता हूँ। बस बता दीजिए।`;
    default:
      return `I'm an automated assistant for ${businessName}, not a person. I can help with questions and quotes from the owner's rate card, and I can get the owner to take over whenever you like. Just say so.`;
  }
}
