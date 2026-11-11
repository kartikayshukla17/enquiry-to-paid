/**
 * Meta's WhatsApp Cloud API webhook signature: `X-Hub-Signature-256: sha256=<hex>`, hex HMAC-SHA256 of the raw
 * body, keyed with the app secret (Meta App Dashboard -> Settings -> Basic -> App Secret). Same scheme as this
 * repo's Razorpay/Stripe adapters (`payments/razorpay-sim.ts`'s `verifyWebhook`) EXCEPT Meta's header carries a
 * `sha256=` prefix the payment providers' headers don't -- stripped here before comparing. `timingSafeEqual`
 * throws on a length mismatch rather than returning false, so the hex shape is validated with a regex first,
 * same discipline `razorpay-sim.ts` uses.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SIG_PREFIX = "sha256=";

export function verifyWhatsAppSignature(appSecret: string, rawBody: string, header: string | undefined): boolean {
  // No app secret configured on this deployment: signature checks simply never succeed (fail closed), same
  // posture as an unset provider secret elsewhere in this repo -- never a crash, never an accidental pass.
  if (!appSecret) return false;
  if (typeof header !== "string" || !header.startsWith(SIG_PREFIX)) return false;
  const hex = header.slice(SIG_PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(hex.toLowerCase(), "hex"), expected);
}
