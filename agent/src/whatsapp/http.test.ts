import { describe, expect, it } from "vitest";
import { whatsappWebhookHttpStatus } from "./http.js";

describe("whatsappWebhookHttpStatus", () => {
  it("2xx for anything handled, so Meta stops retrying", () => {
    for (const r of [{ status: "ignored" }, { status: "held", threadId: "t" }, { status: "acknowledged", threadId: "t" }, { status: "replied", threadId: "t" }] as const) {
      expect(whatsappWebhookHttpStatus(r)).toBe(200);
    }
  });
  it("refuses a forged/unsigned request", () => {
    expect(whatsappWebhookHttpStatus({ status: "rejected", reason: "bad_signature" })).toBe(401);
  });
});
