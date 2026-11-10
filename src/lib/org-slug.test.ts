import { describe, expect, it } from "vitest";
import { randomOrgSlug, toSlug } from "./org-slug";

describe("toSlug", () => {
  it("lowercases and hyphenates a plain business name", () => {
    expect(toSlug("Rose Court Banquets")).toBe("rose-court-banquets");
  });

  it("strips punctuation and collapses repeated separators", () => {
    expect(toSlug("Olive & Mina's Caterers!!")).toBe("olive-mina-s-caterers");
  });

  it("trims leading and trailing hyphens", () => {
    expect(toSlug("  -- Fictional Co. --  ")).toBe("fictional-co");
  });

  it("falls back to a default when nothing alphanumeric survives", () => {
    expect(toSlug("♥♥♥")).toBe("business");
  });
});

describe("randomOrgSlug", () => {
  it("appends a short random suffix to the slugified name, using the injected source of randomness", () => {
    expect(randomOrgSlug("Rose Court Banquets", () => "aa11bb22")).toBe("rose-court-banquets-aa11bb22");
  });

  it("two calls with the real default randomness produce different slugs for the same name", () => {
    expect(randomOrgSlug("Rose Court Banquets")).not.toBe(randomOrgSlug("Rose Court Banquets"));
  });
});
