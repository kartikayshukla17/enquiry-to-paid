import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GRAPH_API_VERSION, sendWhatsAppText } from "./send.js";

function fakeFetch(status: number, json: unknown) {
  return vi.fn(async (_url: string, _init?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json }) as unknown as Response);
}

describe("sendWhatsAppText", () => {
  it("POSTs to the Cloud API messages endpoint with the right URL, auth header, and JSON body", async () => {
    const f = fakeFetch(200, { messages: [{ id: "wamid.OUT1" }] });
    const r = await sendWhatsAppText({ token: "tok-123", phoneNumberId: "pn-456", fetchImpl: f as unknown as typeof fetch }, "919900000001", "hello there");
    expect(r).toEqual({ ok: true, messageId: "wamid.OUT1" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/${DEFAULT_GRAPH_API_VERSION}/pn-456/messages`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(JSON.parse(init.body as string)).toEqual({ messaging_product: "whatsapp", to: "919900000001", type: "text", text: { body: "hello there" } });
  });

  it("never calls the real global fetch -- only the injected one", async () => {
    const realFetch = globalThis.fetch;
    let realFetchCalled = false;
    globalThis.fetch = (async () => {
      realFetchCalled = true;
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    try {
      const f = fakeFetch(200, { messages: [{ id: "wamid.OUT2" }] });
      await sendWhatsAppText({ token: "t", phoneNumberId: "p", fetchImpl: f as unknown as typeof fetch }, "919900000002", "hi");
      expect(realFetchCalled).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("surfaces the provider's error message on a non-2xx response", async () => {
    const f = fakeFetch(401, { error: { message: "FICTIONAL: Invalid OAuth access token" } });
    const r = await sendWhatsAppText({ token: "bad", phoneNumberId: "p", fetchImpl: f as unknown as typeof fetch }, "919900000003", "hi");
    expect(r).toEqual({ ok: false, error: "FICTIONAL: Invalid OAuth access token" });
  });

  it("falls back to a plain HTTP status when the error body is not JSON-shaped", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error("not json"); } }) as unknown as Response);
    const r = await sendWhatsAppText({ token: "t", phoneNumberId: "p", fetchImpl: f as unknown as typeof fetch }, "919900000004", "hi");
    expect(r).toEqual({ ok: false, error: "HTTP 500" });
  });

  it("an explicit apiVersion overrides the default", async () => {
    const f = fakeFetch(200, { messages: [{ id: "wamid.OUT3" }] });
    await sendWhatsAppText({ token: "t", phoneNumberId: "p", apiVersion: "v99.0", fetchImpl: f as unknown as typeof fetch }, "919900000005", "hi");
    const [url] = f.mock.calls[0] as [string];
    expect(url).toBe("https://graph.facebook.com/v99.0/p/messages");
  });
});
