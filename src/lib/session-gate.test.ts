import { describe, expect, it } from "vitest";
import { shouldRedirectToLogin } from "./session-gate";

describe("shouldRedirectToLogin", () => {
  it("redirects an unauthenticated visitor hitting /app", () => {
    expect(shouldRedirectToLogin("/app", false)).toBe(true);
  });

  it("redirects an unauthenticated visitor hitting a nested /app path", () => {
    expect(shouldRedirectToLogin("/app/onboarding", false)).toBe(true);
  });

  it("does not redirect an authenticated visitor on /app", () => {
    expect(shouldRedirectToLogin("/app", true)).toBe(false);
  });

  it("never redirects /login, authenticated or not", () => {
    expect(shouldRedirectToLogin("/login", false)).toBe(false);
    expect(shouldRedirectToLogin("/login", true)).toBe(false);
  });

  it("never redirects /account", () => {
    expect(shouldRedirectToLogin("/account", false)).toBe(false);
  });

  it("never redirects an /api/* route", () => {
    expect(shouldRedirectToLogin("/api/auth/get-session", false)).toBe(false);
  });

  it("never redirects the public marketing or simulator pages", () => {
    expect(shouldRedirectToLogin("/", false)).toBe(false);
    expect(shouldRedirectToLogin("/simulator", false)).toBe(false);
  });

  it("does not treat a path merely starting with 'app' as protected (e.g. /application)", () => {
    expect(shouldRedirectToLogin("/application", false)).toBe(false);
  });
});
