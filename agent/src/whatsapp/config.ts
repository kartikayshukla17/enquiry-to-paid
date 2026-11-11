/**
 * Reads the four WhatsApp Cloud API credentials from the environment, the same shape
 * `payments/razorpay-sim.ts`'s `razorpaySecretFromEnv`/`payments/stripe-sim.ts`'s `stripeSecretFromEnv` read
 * their own provider's secret. Unlike those two (which fall back to a labelled demo value so the simulator
 * always works), there is no simulated WhatsApp provider here -- an unset credential becomes `""`, never a
 * thrown error, and every seam that consumes one (`verifyWhatsAppSignature`'s `appSecret`, `verifyHandshake`'s
 * `verifyToken`) already treats `""` as "never succeeds" rather than "always succeeds". A real deployment with
 * `agent/.env` unset therefore just 403s/401s every WhatsApp request instead of crashing.
 */
export interface WhatsAppConfig {
  appSecret: string;
  verifyToken: string;
  token: string;
  phoneNumberId: string;
}

export function whatsappConfigFromEnv(env: Record<string, string | undefined> = process.env): WhatsAppConfig {
  return {
    appSecret: env.WHATSAPP_APP_SECRET ?? "",
    verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? "",
    token: env.WHATSAPP_TOKEN ?? "",
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  };
}
