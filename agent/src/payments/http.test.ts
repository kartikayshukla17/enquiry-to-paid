import { describe, expect, it } from "vitest";
import { webhookHttpStatus } from "./http.js";

describe("webhookHttpStatus", () => {
  it("2xx for anything handled, so providers stop retrying", () => {
    for (const r of [
      { status: "collected", threadId: "t", paymentId: "p", amountMinor: 1 },
      { status: "duplicate" },
      { status: "ignored", reason: "unknown_link" },
      { status: "mismatch", reason: "amount_mismatch", threadId: "t", paymentId: "p" },
    ] as const) expect(webhookHttpStatus(r)).toBe(200);
  });
  it("refuses forged, malformed and unknown-provider requests", () => {
    expect(webhookHttpStatus({ status: "rejected", reason: "bad_signature" })).toBe(401);
    expect(webhookHttpStatus({ status: "rejected", reason: "unparseable" })).toBe(400);
    expect(webhookHttpStatus({ status: "rejected", reason: "unknown_provider" })).toBe(404);
  });
});
