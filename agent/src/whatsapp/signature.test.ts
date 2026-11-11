import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWhatsAppSignature } from "./signature.js";

const SECRET = "test-only-whatsapp-app-secret-not-real";
const sig = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifyWhatsAppSignature", () => {
  it("accepts a valid sha256= signature over the exact raw body", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyWhatsAppSignature(SECRET, body, sig(body))).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyWhatsAppSignature(SECRET, body, sig(body, "a-different-secret"))).toBe(false);
  });

  it("rejects when the body was tampered with after signing", () => {
    const body = JSON.stringify({ a: 1 });
    const header = sig(body);
    expect(verifyWhatsAppSignature(SECRET, JSON.stringify({ a: 2 }), header)).toBe(false);
  });

  it("rejects a header missing the sha256= prefix", () => {
    const body = "{}";
    const raw = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyWhatsAppSignature(SECRET, body, raw)).toBe(false);
  });

  it("rejects a malformed hex payload without ever calling timingSafeEqual on it", () => {
    expect(verifyWhatsAppSignature(SECRET, "{}", "sha256=not-hex")).toBe(false);
    expect(verifyWhatsAppSignature(SECRET, "{}", "sha256=")).toBe(false);
    expect(verifyWhatsAppSignature(SECRET, "{}", "sha256=abcd")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyWhatsAppSignature(SECRET, "{}", undefined)).toBe(false);
  });

  it("never succeeds when no app secret is configured, even against a correctly-signed-with-empty-key header", () => {
    const body = "{}";
    expect(verifyWhatsAppSignature("", body, sig(body, ""))).toBe(false);
  });
});
