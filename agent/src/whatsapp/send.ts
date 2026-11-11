/**
 * Thin WhatsApp Cloud API client: `POST https://graph.facebook.com/v<version>/<phoneNumberId>/messages`.
 * `fetch` is injected (never called by any other seam in this module -- `handleWhatsAppWebhook` only ever
 * calls a `send` function it was given, so tests never hit the network), same DI pattern this repo already
 * uses for `LlmProvider` and `PaymentProvider`.
 */
export interface SendWhatsAppDeps {
  token: string;
  phoneNumberId: string;
  /** Graph API version, e.g. "v22.0". Defaults to `DEFAULT_GRAPH_API_VERSION` below. */
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

// Looked up live (WebSearch, 2026-11-11): Meta's Graph API changelog lists v26.0 (released 2026-07-29,
// "available until TBD") as the current version; v24.0 (released 2025-10-08, per Meta's own announcement
// post) is a stable, well-established one, not the bleeding-edge just-released version. To bump this later:
// check https://developers.facebook.com/docs/graph-api/changelog for the current version and re-verify
// rather than assuming this comment is still fresh, same caution this repo already applies to the Groq
// rate-limit number in docs/SETUP.md.
export const DEFAULT_GRAPH_API_VERSION = "v24.0";

export type SendWhatsAppResult = { ok: true; messageId?: string } | { ok: false; error: string };

export async function sendWhatsAppText(deps: SendWhatsAppDeps, to: string, body: string): Promise<SendWhatsAppResult> {
  const f = deps.fetchImpl ?? fetch;
  const version = deps.apiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const res = await f(`https://graph.facebook.com/${version}/${deps.phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
  });
  const j = (await res.json().catch(() => ({}))) as { messages?: { id?: unknown }[]; error?: { message?: string } };
  if (!res.ok) return { ok: false, error: j.error?.message ?? `HTTP ${res.status}` };
  const id = j.messages?.[0]?.id;
  return { ok: true, ...(typeof id === "string" && { messageId: id }) };
}
