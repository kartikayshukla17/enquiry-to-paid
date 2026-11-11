/**
 * Pulls the first real inbound text message out of Meta's webhook envelope
 * (`entry[].changes[].value.messages[]`). Out of scope for v1 (same posture as the ticket's "no separate
 * pricing or wording logic" line): status/delivery-receipt payloads (`value.statuses`, no `messages` at all)
 * and non-text message types (image/audio/location/etc.) both resolve to `{ kind: "none" }`, never a throw --
 * same as malformed/unexpected JSON. Nothing here ever decides what to DO with a message, only whether one
 * exists and what it says.
 */
export type WhatsAppInbound = { kind: "message"; from: string; text: string; messageId: string } | { kind: "none" };

interface RawMessage {
  from?: unknown;
  id?: unknown;
  type?: unknown;
  text?: { body?: unknown };
}

export function parseWhatsAppInbound(rawBody: string): WhatsAppInbound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { kind: "none" };
  }
  const entries = (parsed as { entry?: unknown } | null)?.entry;
  if (!Array.isArray(entries)) return { kind: "none" };
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown } | null)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown } } | null)?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const m of messages) {
        const msg = m as RawMessage;
        if (typeof msg.from !== "string" || typeof msg.id !== "string" || msg.type !== "text") continue;
        const body = msg.text?.body;
        if (typeof body !== "string") continue;
        return { kind: "message", from: msg.from, text: body, messageId: msg.id };
      }
    }
  }
  return { kind: "none" };
}
