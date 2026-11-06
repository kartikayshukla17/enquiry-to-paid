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

export type RefusalReason = "no_covering_rule" | "missing_required_field" | "date_unavailable";

export interface Refusal {
  kind: "refusal";
  reason: RefusalReason;
  ruleGap?: string;
}

export type Outcome = Quote | Refusal;

/** Typed ExtractedFields: the only customer-derived input the kernel ever sees. */
export interface ExtractedFields {
  service?: string;
  date?: string; // YYYY-MM-DD
  guestCount?: number;
  locality?: string;
  language: string;
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
