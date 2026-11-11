import { describe, expect, it } from "vitest";
import { parseWhatsAppInbound } from "./inbound.js";

function envelope(value: unknown) {
  return JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ value, field: "messages" }] }] });
}

describe("parseWhatsAppInbound", () => {
  it("extracts a real inbound text message", () => {
    const body = envelope({
      messaging_product: "whatsapp",
      metadata: { phone_number_id: "123" },
      contacts: [{ profile: { name: "FICTIONAL" }, wa_id: "919900000001" }],
      messages: [{ from: "919900000001", id: "wamid.ABC", timestamp: "1700000000", type: "text", text: { body: "hello" } }],
    });
    expect(parseWhatsAppInbound(body)).toEqual({ kind: "message", from: "919900000001", text: "hello", messageId: "wamid.ABC" });
  });

  it("a status/delivery-receipt payload (no messages array) is none", () => {
    const body = envelope({ messaging_product: "whatsapp", statuses: [{ id: "wamid.ABC", status: "delivered" }] });
    expect(parseWhatsAppInbound(body)).toEqual({ kind: "none" });
  });

  it("a non-text message type (image) is none -- out of scope for v1", () => {
    const body = envelope({ messages: [{ from: "919900000001", id: "wamid.IMG", type: "image", image: { id: "media-1" } }] });
    expect(parseWhatsAppInbound(body)).toEqual({ kind: "none" });
  });

  it("malformed JSON resolves to none, never a throw", () => {
    expect(parseWhatsAppInbound("{not json")).toEqual({ kind: "none" });
    expect(parseWhatsAppInbound("")).toEqual({ kind: "none" });
    expect(parseWhatsAppInbound("null")).toEqual({ kind: "none" });
    expect(parseWhatsAppInbound("[]")).toEqual({ kind: "none" });
    expect(parseWhatsAppInbound('"just a string"')).toEqual({ kind: "none" });
  });

  it("an empty entry/changes/messages array is none", () => {
    expect(parseWhatsAppInbound(JSON.stringify({ entry: [] }))).toEqual({ kind: "none" });
    expect(parseWhatsAppInbound(envelope({}))).toEqual({ kind: "none" });
  });

  it("finds the first real text message when a status and a text message are both present", () => {
    const body = JSON.stringify({
      entry: [
        { changes: [{ value: { statuses: [{ id: "wamid.status" }] } }] },
        { changes: [{ value: { messages: [{ from: "919900000002", id: "wamid.XYZ", type: "text", text: { body: "second entry" } }] } }] },
      ],
    });
    expect(parseWhatsAppInbound(body)).toEqual({ kind: "message", from: "919900000002", text: "second entry", messageId: "wamid.XYZ" });
  });
});
