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

function renderQuote(q: Quote, f: ExtractedFields): string {
  const rows = q.lines.map((l) => `- ${l.label}: ${formatMoney(l.amount, q.currency)}`);
  const intro =
    f.guestCount !== undefined && f.date
      ? `Thank you for your enquiry! Here is your quote for ${f.guestCount} guests on ${formatDate(f.date)}:`
      : "Thank you for your enquiry! Here is your quote:";
  return [
    intro,
    "",
    ...rows,
    "",
    `Total: ${formatMoney(q.total, q.currency)}`,
    `This quote is valid until ${formatDate(q.validUntil)}.`,
  ].join("\n");
}

/**
 * Builds the customer-facing reply. Every number comes from the kernel outcome
 * (or the typed fields it priced); there is no free-text number path.
 */
export function renderReply(outcome: Outcome, fields: ExtractedFields): string {
  if (outcome.kind === "quote") return renderQuote(outcome, fields);
  return holdingReply(outcome.reason);
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
