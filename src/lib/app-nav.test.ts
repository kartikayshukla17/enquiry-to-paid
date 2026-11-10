import { describe, expect, it } from "vitest";
import { activeNavKey, APP_NAV_ITEMS } from "./app-nav";

describe("APP_NAV_ITEMS", () => {
  it("lists Inbox, Quotes, Escalations in that order", () => {
    expect(APP_NAV_ITEMS.map((i) => i.label)).toEqual(["Inbox", "Quotes", "Escalations"]);
  });
});

describe("activeNavKey", () => {
  it("matches the exact route for each nav item", () => {
    expect(activeNavKey("/app/inbox")).toBe("inbox");
    expect(activeNavKey("/app/quotes")).toBe("quotes");
    expect(activeNavKey("/app/escalations")).toBe("escalations");
  });

  it("matches a nested path under a nav item's route", () => {
    expect(activeNavKey("/app/inbox/thread-1")).toBe("inbox");
  });

  it("is null for a route no nav item owns", () => {
    expect(activeNavKey("/app/onboarding")).toBeNull();
    expect(activeNavKey("/app")).toBeNull();
  });

  it("does not let one item's path prefix-match another's", () => {
    // Guards against a naive startsWith("/app/inbox") also matching "/app/inboxoid".
    expect(activeNavKey("/app/inboxoid")).toBeNull();
  });
});
