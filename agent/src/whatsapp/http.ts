import type { WhatsAppWebhookResult } from "./webhook.js";

/** HTTP status for a webhook outcome, same convention as `payments/http.ts`'s `webhookHttpStatus`: everything
 *  understood and safely handled (ignored, held, acknowledged, replied) is 200, so Meta stops retrying; only
 *  a forged/unsigned request is refused. */
export function whatsappWebhookHttpStatus(r: WhatsAppWebhookResult): number {
  return r.status === "rejected" ? 401 : 200;
}
