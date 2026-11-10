import { describe, expect, it } from "vitest";
import { orgDisplayName } from "./org-display";

describe("orgDisplayName", () => {
  it("returns the org name as-is when present", () => {
    expect(orgDisplayName("Rose Court")).toBe("Rose Court");
  });

  it("trims surrounding whitespace", () => {
    expect(orgDisplayName("  Rose Court  ")).toBe("Rose Court");
  });

  it("falls back when the name is only whitespace", () => {
    expect(orgDisplayName("   ")).toBe("Your business");
  });

  it("falls back when the name is undefined", () => {
    expect(orgDisplayName(undefined)).toBe("Your business");
  });

  it("falls back when the name is null", () => {
    expect(orgDisplayName(null)).toBe("Your business");
  });
});
