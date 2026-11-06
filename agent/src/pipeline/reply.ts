import type { ExtractedFields, Outcome, Quote } from "../kernel/types.js";

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
  // Safe holding reply (T2 completes the refusal path): no numbers, no promises.
  return "Thank you for your enquiry! A member of our team will review the details and get back to you shortly.";
}
