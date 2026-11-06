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

function quoteTemplate(q: Quote, f: ExtractedFields): ReplyTemplate {
  const hasEcho = f.guestCount !== undefined && f.date;
  const intro = hasEcho
    ? "Thank you for your enquiry! Here is your quote for {{guestCount}} guests on {{date}}:"
    : "Thank you for your enquiry! Here is your quote:";
  return {
    kind: "quote",
    template: [intro, "", "{{lines}}", "", "Total: {{total}}", "This quote is valid until {{validUntil}}."].join("\n"),
    values: {
      ...(hasEcho && { guestCount: String(f.guestCount), date: formatDate(f.date as string) }),
      lines: q.lines.map((l) => `- ${l.label}: ${formatMoney(l.amount, q.currency)}`).join("\n"),
      total: formatMoney(q.total, q.currency),
      validUntil: formatDate(q.validUntil),
    },
  };
}

/** The template behind a reply that may be LLM-worded (quote, clarifying question); undefined for holding replies. */
export function replyTemplate(outcome: Outcome, fields: ExtractedFields, rateCard?: unknown): ReplyTemplate | undefined {
  if (outcome.kind === "quote") return quoteTemplate(outcome, fields);
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
export function renderReply(outcome: Outcome, fields: ExtractedFields, rateCard?: unknown): string {
  const t = replyTemplate(outcome, fields, rateCard);
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
    case "no_covering_rule":
    case "discount_request":
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
 * The question for the one field the kernel named (`ruleGap`), taken verbatim from the card's
 * `requiredFields`. Returns undefined when the card has no such entry (never invents a question).
 */
export function clarifyingQuestion(field: string | undefined, rateCard: unknown): string | undefined {
  const required = (rateCard as { requiredFields?: { field: string; question: string }[] } | undefined)?.requiredFields;
  return required?.find((r) => r.field === field)?.question;
}
