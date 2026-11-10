import { describe, expect, it } from "vitest";
import { businessNameFromCard } from "./business-name.js";

describe("businessNameFromCard", () => {
  it("pulls the fictional business name out of the card's label", () => {
    expect(businessNameFromCard({ label: "FICTIONAL: Lensfolk Studio sample rate card (packages, extra hours)" })).toBe("FICTIONAL: Lensfolk Studio");
    expect(businessNameFromCard({ label: "FICTIONAL: Rose Court Banquets sample rate card" })).toBe("FICTIONAL: Rose Court Banquets");
  });
  it("falls back to the raw label, then to a generic name, rather than throwing", () => {
    expect(businessNameFromCard({ label: "Some other label shape" })).toBe("Some other label shape");
    expect(businessNameFromCard({})).toBe("FICTIONAL: Test business");
    expect(businessNameFromCard(undefined)).toBe("FICTIONAL: Test business");
  });
});
