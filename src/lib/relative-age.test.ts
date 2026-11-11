import { describe, expect, it } from "vitest";
import { formatRelativeAge } from "./relative-age";

describe("formatRelativeAge", () => {
  const now = new Date("2026-11-07T12:00:00Z").getTime();

  it("says 'just now' for anything under a minute old", () => {
    expect(formatRelativeAge("2026-11-07T11:59:30Z", now)).toBe("just now");
    expect(formatRelativeAge("2026-11-07T12:00:00Z", now)).toBe("just now");
  });

  it("formats whole minutes under an hour", () => {
    expect(formatRelativeAge("2026-11-07T11:59:00Z", now)).toBe("1m ago");
    expect(formatRelativeAge("2026-11-07T11:45:00Z", now)).toBe("15m ago");
  });

  it("formats whole hours under a day", () => {
    expect(formatRelativeAge("2026-11-07T10:00:00Z", now)).toBe("2h ago");
    expect(formatRelativeAge("2026-11-06T13:00:00Z", now)).toBe("23h ago");
  });

  it("formats whole days for anything a day or older", () => {
    expect(formatRelativeAge("2026-11-06T12:00:00Z", now)).toBe("1d ago");
    expect(formatRelativeAge("2026-10-28T12:00:00Z", now)).toBe("10d ago");
  });

  it("never goes negative for a clock-skewed future timestamp", () => {
    expect(formatRelativeAge("2026-11-07T12:05:00Z", now)).toBe("just now");
  });

  it("falls back to the raw string for an unparseable timestamp", () => {
    expect(formatRelativeAge("not-a-date", now)).toBe("not-a-date");
  });
});
