import { describe, expect, it } from "vitest";
import { maskCustomerRef } from "./mask-customer-ref.js";

describe("maskCustomerRef", () => {
  it("shows only the last 3 characters of a phone-shaped ref, masking the rest", () => {
    const out = maskCustomerRef("+91 98765 43210");
    expect(out.endsWith("210")).toBe(true);
    expect(out).not.toContain("98765");
    expect(out).not.toBe("+91 98765 43210");
  });

  it("behaves sanely for the simulator's non-phone-shaped ref", () => {
    const out = maskCustomerRef("web-sim-customer");
    expect(out.endsWith("mer")).toBe(true);
    expect(out).not.toContain("web-sim");
    expect(out).not.toBe("web-sim-customer");
  });

  it("uses a fixed-width mask so the output length never reveals the raw input's length", () => {
    const short = maskCustomerRef("ab1234");
    const long = maskCustomerRef("+91 00000 00001 extra padding to be much longer");
    const maskWidth = (s: string, tailLen: number) => s.length - tailLen;
    expect(maskWidth(short, 3)).toBe(maskWidth(long, 3));
  });

  it("never returns the raw value unmasked", () => {
    expect(maskCustomerRef("+919876543210")).not.toBe("+919876543210");
    expect(maskCustomerRef("web-sim-customer")).not.toBe("web-sim-customer");
  });

  it("never returns an empty or blank string, even for an empty input", () => {
    expect(maskCustomerRef("").trim().length).toBeGreaterThan(0);
  });

  it("handles a ref exactly at the visible-tail length", () => {
    const out = maskCustomerRef("abc");
    expect(out.endsWith("abc")).toBe(true);
    expect(out.length).toBeGreaterThan(3);
  });

  it("is deterministic: the same input always masks the same way", () => {
    expect(maskCustomerRef("+91 98765 43210")).toBe(maskCustomerRef("+91 98765 43210"));
  });
});
