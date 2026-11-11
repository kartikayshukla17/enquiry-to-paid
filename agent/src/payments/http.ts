import type { WebhookResult } from "./webhook.js";

/**
 * HTTP status for a webhook outcome. Providers retry anything that is not 2xx, so everything that was understood and
 * safely handled (collected, duplicate, ignored, mismatch, held_for_review -- V11's expired-quote case, failed,
 * refunded -- V12's two new event kinds: received and acknowledged, just not actioned the normal way) is 200. Only a
 * forged/unsigned request or an unknown provider path is refused, and nothing in the response body reveals why
 * beyond a short code.
 */
export function webhookHttpStatus(r: WebhookResult): number {
  if (r.status !== "rejected") return 200;
  if (r.reason === "bad_signature") return 401;
  if (r.reason === "unknown_provider") return 404;
  return 400;
}
