/**
 * Meta's one-time `GET` webhook subscription check (App Dashboard -> WhatsApp -> Configuration -> "Verify and
 * save"): the request carries `hub.mode=subscribe`, `hub.verify_token=<whatever we told Meta to send back>`
 * and `hub.challenge=<arbitrary string>`; the correct response is `hub.challenge`'s value, echoed back
 * verbatim as the plain-text response body. Wrong mode or token: reject (the HTTP layer maps this to 403).
 */
export type WhatsAppHandshakeResult = { ok: true; challenge: string } | { ok: false };

export function verifyHandshake(query: Record<string, string | undefined>, verifyToken: string): WhatsAppHandshakeResult {
  // No verify token configured on this deployment: the handshake simply never succeeds (fail closed), same
  // posture `verifyWhatsAppSignature` takes for an unset app secret.
  if (!verifyToken) return { ok: false };
  if (query["hub.mode"] !== "subscribe") return { ok: false };
  if (query["hub.verify_token"] !== verifyToken) return { ok: false };
  const challenge = query["hub.challenge"];
  if (typeof challenge !== "string" || challenge === "") return { ok: false };
  return { ok: true, challenge };
}
