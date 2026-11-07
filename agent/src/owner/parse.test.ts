import { describe, expect, it } from "vitest";
import { parseOwnerReply } from "./parse.js";

describe("parseOwnerReply: owner text becomes a typed command, deterministically (no LLM)", () => {
  it.each([
    ["quote 85000", { kind: "quote", amountMinor: 8_500_000 }],
    ["Quote Rs 85,000", { kind: "quote", amountMinor: 8_500_000 }],
    ["quote ₹85,000", { kind: "quote", amountMinor: 8_500_000 }],
    ["quote rs.1,20,000.50", { kind: "quote", amountMinor: 12_000_050 }],
    ["quote R12 85000", { kind: "quote", ref: "R12", amountMinor: 8_500_000 }],
    ["  QUOTE   r7   inr 500 ", { kind: "quote", ref: "R7", amountMinor: 50_000 }],
    ["decline", { kind: "decline" }],
    ["Decline R3", { kind: "decline", ref: "R3" }],
    ["call them", { kind: "call_them" }],
    ["call them r3", { kind: "call_them", ref: "R3" }],
    ["why", { kind: "why" }],
    ["why R12", { kind: "why", ref: "R12" }],
    ["why q9", { kind: "why", ref: "Q9" }],
    ["digest", { kind: "digest" }],
    ["summary", { kind: "digest" }],
  ])("%s", (text, expected) => {
    expect(parseOwnerReply(text)).toEqual(expected);
  });

  it.each(["hello", "what is the price", "declined", "call", "", "block 2026-12-12 hall maintenance", "show blocks"])("%j is not an owner-reply command", (text) => {
    expect(parseOwnerReply(text)).toBeUndefined();
  });

  it.each(["quote", "quote abc", "quote 0", "quote -5", "quote 12.345", "quote 1e6", "quote 99999999999", "quote R12", "decline R", "why R0x", "why Z4", "quote for 100 guests"])(
    "%j is a usage error, never a guess",
    (text) => {
      expect(parseOwnerReply(text)).toMatchObject({ kind: "usage" });
    },
  );
});
