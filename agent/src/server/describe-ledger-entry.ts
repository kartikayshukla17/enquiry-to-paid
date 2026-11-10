import { describeReason } from "../escalation/index.js";
import { REFUSAL_REASONS, type RefusalReason } from "../kernel/types.js";
import { formatMoney } from "../pipeline/reply.js";

/**
 * Turns one ledger entry's typed payload into a short, one-line, human-readable description --
 * used for the inbox list's `lastMessageSummary` and for each row on the thread detail screen.
 * This project's hard rule (agent/README.md, e.g. T6/T8): the model's own free text is never
 * surfaced as if it were a hard, typed fact. The one deliberate exception is an `enquiry` entry's
 * own customer text, shown verbatim -- it is already plaintext in the ledger payload and the owner
 * already has full access to raw ledger rows on the detail screen, so this is not new exposure.
 * Every other case below builds its sentence only from typed fields that are actually on the
 * payload; nothing here is invented.
 *
 * Proportionate for v1: a switch over `type` (and, for `owner_message`, a second switch over the
 * typed `command` field), with a safe, non-throwing fallback for anything this function does not
 * recognise -- an unknown ledger type or a malformed payload must never crash the inbox/detail
 * screens.
 */

const TEXT_PREVIEW_LEN = 140;
const FALLBACK = "Ledger entry recorded";

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > TEXT_PREVIEW_LEN ? `${trimmed.slice(0, TEXT_PREVIEW_LEN)}…` : trimmed;
}

function money(p: Record<string, unknown>, field: string): string | undefined {
  const amount = p[field];
  const currency = p.currency;
  return typeof amount === "number" && typeof currency === "string" ? formatMoney(amount, currency) : undefined;
}

function isRefusalReason(x: unknown): x is RefusalReason {
  return typeof x === "string" && (REFUSAL_REASONS as readonly string[]).includes(x);
}

function describeOwnerMessage(p: Record<string, unknown>): string {
  const command = typeof p.command === "string" ? p.command : undefined;
  switch (command) {
    case "decline":
      return "Owner declined the enquiry";
    case "call_them":
      return "Owner marked this for a call-back";
    case "reply":
    case "owner_reply":
      return "Owner replied to the customer";
    case "pause":
      return "Owner paused the thread";
    case "handback":
      return "Owner handed the thread back to the agent";
    case "idle_resume":
      return "Thread resumed automatically after owner inactivity";
    case "digest_sent":
      return "Daily digest sent to the owner";
    case "customer_message_surfaced":
      return "Customer message surfaced to the owner";
    case "escalation_sent":
      return "Escalation sent to the owner";
    default:
      // Still typed data (a fixed command code), never free text -- a safe, proportionate fallback.
      return command ? `Owner action: ${command.replace(/_/g, " ")}` : "Owner message";
  }
}

function describeHold(p: Record<string, unknown>): string {
  const resourceId = typeof p.resourceId === "string" ? p.resourceId : undefined;
  if (p.action === "placed") return resourceId ? `Held ${resourceId} for the customer's date` : "Date held for the customer";
  if (p.action === "expired") return resourceId ? `Hold on ${resourceId} expired` : "A hold expired";
  return "Availability hold updated";
}

function describeConsent(p: Record<string, unknown>): string {
  if (p.action === "requested") return "Asked the customer to opt in to reminders";
  if (p.action === "granted") return "Customer opted in to reminders";
  if (p.action === "revoked") return "Customer opted out of reminders";
  return "Reminder consent updated";
}

function describe(entry: { type: string; payload: unknown }): string {
  const p = entry.payload && typeof entry.payload === "object" ? (entry.payload as Record<string, unknown>) : {};
  switch (entry.type) {
    case "enquiry":
      return typeof p.text === "string" && p.text.trim() ? preview(p.text) : "Customer enquiry received";
    case "extraction":
      return "Extracted details from the enquiry";
    case "quote":
      return money(p, "total") ? `Quoted ${money(p, "total")}` : "Quote sent";
    case "owner_quote":
      return money(p, "total") ? `Owner quoted ${money(p, "total")}` : "Owner sent a price";
    case "refusal":
      return isRefusalReason(p.reason) ? `Refused: ${describeReason(p.reason)}` : "Enquiry refused";
    case "hold":
      return describeHold(p);
    case "owner_message":
      return describeOwnerMessage(p);
    case "payment_link":
      return money(p, "amountMinor") ? `Payment link sent for ${money(p, "amountMinor")}` : "Payment link sent";
    case "collected":
      return money(p, "amountMinor") ? `Payment collected (${money(p, "amountMinor")})` : "Payment collected";
    case "payment_mismatch":
      return typeof p.reason === "string" ? `Payment mismatch: ${p.reason.replace(/_/g, " ")}` : "Payment mismatch detected";
    case "chase":
      return p.action === "cancelled" ? "Reminder cancelled" : "Reminder update";
    case "chaser_sent":
      return typeof p.n === "number" ? `Reminder ${p.n} sent` : "Reminder sent";
    case "consent":
      return describeConsent(p);
    case "stop":
      return "Customer asked to stop reminders";
    case "disclosure":
      return "Told the customer this is an automated assistant";
    case "rate_card_approved":
      return "Rate card approved";
    case "rate_card_rejected":
      return "Rate card rejected";
    case "kill_switch_changed":
      return p.on === true ? "Kill switch turned on" : p.on === false ? "Kill switch turned off" : "Kill switch changed";
    case "correction":
      return "Correction recorded";
    default:
      return FALLBACK;
  }
}

export function describeLedgerEntry(entry: { type: string; payload: unknown }): string {
  try {
    return describe(entry);
  } catch {
    return FALLBACK;
  }
}
