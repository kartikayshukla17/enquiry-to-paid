/**
 * Payment provider seam (T15). The agent never holds funds; the provider does. Everything here is SIMULATED in v0:
 * the only implementation is `razorpaySim`, which makes no network call and holds no real key.
 */

export interface CreateLinkRequest {
  /** Our own payment id; the provider echoes it back as the reference. */
  paymentId: string;
  tenantId: string;
  threadId: string;
  /** Integer minor units (paise). Never a float. */
  amountMinor: number;
  currency: string;
  description: string;
  now: string;
}

export interface PaymentLink {
  providerLinkId: string;
  url: string;
}

/** What a verified webhook body means, provider-neutral. */
export type ParsedPaymentEvent =
  | { kind: "paid"; eventId: string; tenantId: string; providerLinkId: string; providerPaymentId: string; amountMinor: number; currency: string }
  | { kind: "other"; eventId: string; tenantId?: string; type: string };

export interface PaymentProvider {
  /** Stable name stored with every payment ("razorpay-sim"). */
  readonly name: string;
  createPaymentLink(req: CreateLinkRequest): Promise<PaymentLink>;
  /** True only if `signature` is the provider's HMAC over the exact raw body. Constant time; false on anything malformed. */
  verifyWebhook(signature: string | undefined, rawBody: string): boolean;
  /** Called only after `verifyWebhook` passed. Returns null for a body that is not a usable event. */
  parseEvent(rawBody: string, headers: Record<string, string | undefined>): ParsedPaymentEvent | null;
}
