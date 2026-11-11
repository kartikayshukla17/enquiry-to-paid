import { describe, expect, it } from "vitest";
import { verifyHandshake } from "./handshake.js";

const TOKEN = "test-only-verify-token-not-real";

describe("verifyHandshake", () => {
  it("echoes the challenge back verbatim when mode and token match", () => {
    const r = verifyHandshake({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "1234567890" }, TOKEN);
    expect(r).toEqual({ ok: true, challenge: "1234567890" });
  });

  it("rejects the wrong verify token", () => {
    const r = verifyHandshake({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "x" }, TOKEN);
    expect(r).toEqual({ ok: false });
  });

  it("rejects a mode other than subscribe", () => {
    const r = verifyHandshake({ "hub.mode": "unsubscribe", "hub.verify_token": TOKEN, "hub.challenge": "x" }, TOKEN);
    expect(r).toEqual({ ok: false });
  });

  it("rejects a missing mode or token or challenge", () => {
    expect(verifyHandshake({ "hub.verify_token": TOKEN, "hub.challenge": "x" }, TOKEN)).toEqual({ ok: false });
    expect(verifyHandshake({ "hub.mode": "subscribe", "hub.challenge": "x" }, TOKEN)).toEqual({ ok: false });
    expect(verifyHandshake({ "hub.mode": "subscribe", "hub.verify_token": TOKEN }, TOKEN)).toEqual({ ok: false });
  });

  it("never succeeds when no verify token is configured on this deployment", () => {
    const r = verifyHandshake({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "x" }, "");
    expect(r).toEqual({ ok: false });
  });
});
