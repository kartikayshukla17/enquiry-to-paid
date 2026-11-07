import { fillTemplate, formatMoney } from "../pipeline/reply.js";

/**
 * Everything that goes to a CUSTOMER because of an owner action is one of these templates. The owner's own words
 * are never forwarded, and the only number in them is the owner's price formatted by code.
 */
export function ownerQuoteMessage(tenantName: string, amountMinor: number, currency: string): string {
  return fillTemplate(
    ["Thank you for your enquiry with {{business}}.", "", "We have looked at your request personally and can offer:", "", "Total: {{total}}", "", "Reply here to confirm and we will take it forward."].join("\n"),
    { business: tenantName, total: formatMoney(amountMinor, currency) },
  );
}

export function declineMessage(tenantName: string): string {
  return fillTemplate(
    "Thank you for thinking of {{business}}. We have looked at your request and, sadly, we are not able to take it on this time. We wish you all the best with your plans.",
    { business: tenantName },
  );
}

export const HELP_TEXT =
  "I did not understand that. You can say: quote 85000, decline, call them, why R12, digest, block 2026-12-12 <reason>, unblock 2026-12-12, show blocks.";
