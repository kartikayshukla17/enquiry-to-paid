import { describe, expect, it } from "vitest";
import { describeLedgerEntry } from "./describe-ledger-entry.js";

describe("describeLedgerEntry", () => {
  it("shows an enquiry's own customer text verbatim (already plaintext, already owner-visible)", () => {
    expect(describeLedgerEntry({ type: "enquiry", payload: { text: "100 guests on 12 Dec" } })).toBe("100 guests on 12 Dec");
  });

  it("truncates a long enquiry to a short one-line preview", () => {
    const text = "a".repeat(200);
    const out = describeLedgerEntry({ type: "enquiry", payload: { text } });
    expect(out.length).toBeLessThan(160);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back for an enquiry with no text field", () => {
    expect(describeLedgerEntry({ type: "enquiry", payload: {} })).toBe("Customer enquiry received");
  });

  it("formats a quote from its typed total/currency", () => {
    expect(describeLedgerEntry({ type: "quote", payload: { total: 85050, currency: "INR" } })).toBe("Quoted ₹850.50");
  });

  it("formats an owner-set quote distinctly from an agent quote", () => {
    expect(describeLedgerEntry({ type: "owner_quote", payload: { total: 85050, currency: "INR" } })).toBe("Owner quoted ₹850.50");
  });

  it("formats a refusal from its typed reason code, never inventing text", () => {
    expect(describeLedgerEntry({ type: "refusal", payload: { reason: "no_covering_rule" } })).toBe("Refused: No rate-card rule covers this enquiry");
  });

  it("never crashes on an unrecognised refusal reason", () => {
    expect(describeLedgerEntry({ type: "refusal", payload: { reason: "made_up_reason" } })).toBe("Enquiry refused");
  });

  it("formats a payment link from its amount", () => {
    expect(describeLedgerEntry({ type: "payment_link", payload: { amountMinor: 85050, currency: "INR" } })).toBe("Payment link sent for ₹850.50");
  });

  it("formats a collected payment", () => {
    expect(describeLedgerEntry({ type: "collected", payload: { amountMinor: 85050, currency: "INR" } })).toBe("Payment collected (₹850.50)");
  });

  it("formats a hold placed for the customer", () => {
    expect(describeLedgerEntry({ type: "hold", payload: { action: "placed", resourceId: "hall-1" } })).toBe("Held hall-1 for the customer's date");
  });

  it("formats an owner decline", () => {
    expect(describeLedgerEntry({ type: "owner_message", payload: { command: "decline" } })).toBe("Owner declined the enquiry");
  });

  it("falls back to the typed command code for an unmodelled owner_message command", () => {
    expect(describeLedgerEntry({ type: "owner_message", payload: { command: "show_blocks" } })).toBe("Owner action: show blocks");
  });

  it("formats consent events", () => {
    expect(describeLedgerEntry({ type: "consent", payload: { action: "granted" } })).toBe("Customer opted in to reminders");
  });

  it("describes a disclosure entry", () => {
    expect(describeLedgerEntry({ type: "disclosure", payload: { kind: "disclosure" } })).toBe("Told the customer this is an automated assistant");
  });

  it("never throws and always returns a non-empty string for an unknown type", () => {
    expect(describeLedgerEntry({ type: "something_new", payload: { anything: true } }).length).toBeGreaterThan(0);
  });

  it("never throws on a malformed/non-object payload", () => {
    expect(describeLedgerEntry({ type: "quote", payload: "not-an-object" }).length).toBeGreaterThan(0);
    expect(describeLedgerEntry({ type: "quote", payload: null }).length).toBeGreaterThan(0);
  });
});
