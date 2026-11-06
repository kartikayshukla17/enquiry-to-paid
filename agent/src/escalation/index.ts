import { assertNever, type ExtractedFields, type RefusalReason } from "../kernel/types.js";

/**
 * What the owner needs to pick a refused enquiry up. Typed fields only: no free text from the
 * customer and never a raw phone number (the thread id is the handle).
 */
export interface EscalationEvent {
  tenantId: string;
  threadId: string;
  at: string;
  reason: RefusalReason;
  ruleGap?: string;
  /** The card's suggested next step for this kind of refusal (a short code), when the card names one. */
  suggestion?: string;
  fields: ExtractedFields;
}

/** Stub seam for owner notification. v0 logs; a WhatsApp/owner-app implementation replaces it later. */
export interface Notifier {
  notify(event: EscalationEvent): Promise<void>;
}

/** Owner-facing one-line summary of why the agent stepped back. */
export function describeReason(reason: RefusalReason): string {
  switch (reason) {
    case "no_covering_rule":
      return "No rate-card rule covers this enquiry";
    case "missing_required_field":
      return "A required detail is missing";
    case "date_unavailable":
      return "The requested date is not available";
    case "discount_request":
      return "Customer asked for a discount or special deal";
    case "low_confidence":
      return "Could not read the enquiry with enough confidence";
    case "out_of_policy":
      return "Request falls outside the owner's policy";
    case "calendar_mismatch":
      return "Requested date does not match the calendar";
    default:
      return assertNever(reason);
  }
}

export function formatEscalation(e: EscalationEvent): string {
  const gap = e.ruleGap ? ` ruleGap=${e.ruleGap}` : "";
  const suggestion = e.suggestion ? ` suggestion=${e.suggestion}` : "";
  return `[escalation] tenant=${e.tenantId} thread=${e.threadId} reason=${e.reason}${gap}${suggestion} fields=${JSON.stringify(e.fields)} note="${describeReason(e.reason)}"`;
}

export function createLogNotifier(log: (line: string) => void = console.log): Notifier {
  return {
    notify(e) {
      log(formatEscalation(e));
      return Promise.resolve();
    },
  };
}

/** Test/in-memory notifier that appends events to the given array. */
export function collectingNotifier(sink: EscalationEvent[]): Notifier {
  return {
    notify(e) {
      sink.push(e);
      return Promise.resolve();
    },
  };
}
