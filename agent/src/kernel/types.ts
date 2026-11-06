/** Typed view of kernel output. Mirrors kernel/src/eval.rs; money is integer minor units. */
export interface QuoteLine {
  label: string;
  amount: number;
  ruleId: string;
}

export interface Quote {
  kind: "quote";
  rateCardHash: string;
  currency: string;
  total: number;
  validUntil: string;
  lines: QuoteLine[];
}

/** Mirrors `RefusalReason::code()` in kernel/src/eval.rs. Closed set. */
export const REFUSAL_REASONS = [
  "no_covering_rule",
  "missing_required_field",
  "date_unavailable",
  "discount_request",
  "low_confidence",
  "out_of_policy",
  "calendar_mismatch",
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** Compile-time exhaustiveness: pass the leftover value of a switch's default branch. */
export function assertNever(x: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}

export interface Refusal {
  kind: "refusal";
  reason: RefusalReason;
  ruleGap?: string;
}

export type Outcome = Quote | Refusal;

/** The agent answered "are you a bot?" honestly instead of pricing; the kernel was not consulted. */
export interface Disclosure {
  kind: "disclosure";
}
/** What the pipeline can end a turn with. */
export type TurnOutcome = Outcome | Disclosure;

/** What the customer is trying to do, as classified by extraction. A closed enum: never free text. */
export const INTENTS = ["enquiry", "discount_request", "negotiation", "package_deal", "asks_if_bot", "other"] as const;
export type Intent = (typeof INTENTS)[number];
/** Intents the owner must handle: the kernel refuses them (reason discount_request). */
export const NEGOTIATION_INTENTS: readonly Intent[] = ["discount_request", "negotiation", "package_deal"];

/** Typed ExtractedFields: the only customer-derived input the kernel ever sees. */
export interface ExtractedFields {
  service?: string;
  date?: string; // YYYY-MM-DD
  guestCount?: number;
  locality?: string;
  language: string;
  /** Per-message classification; never stored on the thread. Absent means the model did not classify. */
  intent?: Intent;
  confidenceBps: number; // integer basis points; no floats anywhere
}

export interface Availability {
  blockedDates: string[];
}

export class KernelError extends Error {
  constructor(public readonly code: string) {
    super(`kernel error: ${code}`);
  }
}
