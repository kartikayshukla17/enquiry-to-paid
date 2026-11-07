/**
 * Owner replies parsed into typed commands. Deterministic text matching, no LLM: the owner's words either match one of
 * these forms or they do not. A near-miss is a usage error, never a guess (a mis-read price would reach a customer).
 *
 *   quote 85000 | quote Rs 85,000 | quote ₹85,000.50 | quote R12 85000     (amount in major units; becomes integer minor units)
 *   decline | decline R12
 *   call them | call them R12
 *   why | why R12 | why Q9
 *   digest
 *
 * A ref (`R<n>` for a refusal, `Q<n>` for a quote) is optional on the action commands: without one, the command applies
 * to the only enquiry still waiting for the owner.
 */
export type OwnerReply =
  | { kind: "quote"; ref?: string; amountMinor: number }
  | { kind: "decline"; ref?: string }
  | { kind: "call_them"; ref?: string }
  | { kind: "why"; ref?: string }
  | { kind: "digest" }
  | { kind: "usage"; error: string };

/** Largest price accepted, in major units: 99,999,999 (so minor units stay far inside Number's exact integer range). */
const MAX_MAJOR_DIGITS = 8;
const REF = String.raw`([rq]\d+)`;
const QUOTE_RE = new RegExp(String.raw`^quote(?:\s+${REF})?\s+(?:rs\.?\s*|inr\s*|₹\s*)?(\d[\d,]*(?:\.\d{1,2})?)$`, "i");
const DECLINE_RE = new RegExp(String.raw`^decline(?:\s+${REF})?$`, "i");
const CALL_RE = new RegExp(String.raw`^call\s+them(?:\s+${REF})?$`, "i");
const WHY_RE = new RegExp(String.raw`^why(?:\s+${REF})?$`, "i");
const DIGEST_RE = /^(?:daily\s+)?(?:digest|summary)$/i;

const withRef = <K extends "decline" | "call_them" | "why">(kind: K, ref: string | undefined) => ({ kind, ...(ref && { ref: ref.toUpperCase() }) });

/** Returns undefined when the text is not an owner-reply command at all. */
export function parseOwnerReply(text: string): OwnerReply | undefined {
  const t = text.trim().replace(/\s+/g, " ");
  const q = QUOTE_RE.exec(t);
  if (q) {
    const [whole, frac = ""] = (q[2] as string).replace(/,/g, "").split(".");
    const digits = (whole as string).replace(/^0+(?=\d)/, "");
    if (digits.length > MAX_MAJOR_DIGITS) return { kind: "usage", error: "That amount is too large. Say it like: quote 85000" };
    const amountMinor = Number(digits) * 100 + Number(frac.padEnd(2, "0"));
    if (amountMinor <= 0) return { kind: "usage", error: "A quote must be more than zero. Say it like: quote 85000" };
    return { kind: "quote", ...(q[1] && { ref: q[1].toUpperCase() }), amountMinor };
  }
  if (/^quote\b/i.test(t)) return { kind: "usage", error: "Say it like: quote 85000 (or quote R12 85000)" };
  const d = DECLINE_RE.exec(t);
  if (d) return withRef("decline", d[1]);
  if (/^decline\b/i.test(t)) return { kind: "usage", error: "Say it like: decline (or decline R12)" };
  const c = CALL_RE.exec(t);
  if (c) return withRef("call_them", c[1]);
  if (/^call\s+them\b/i.test(t)) return { kind: "usage", error: "Say it like: call them (or call them R12)" };
  const w = WHY_RE.exec(t);
  if (w) return withRef("why", w[1]);
  if (/^why\b/i.test(t)) return { kind: "usage", error: "Say it like: why R12 (the ref is in the escalation message)" };
  if (DIGEST_RE.test(t)) return { kind: "digest" };
  return undefined;
}
