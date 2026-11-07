/**
 * Chaser wording. Fixed strings only: the one place a number can come from is the kernel quote (formatted by code), and the
 * only other values are the business name and the code-issued payment link. No model writes, rewords or sees any of this.
 * The same body is used as the approved WhatsApp template (outside the customer's 24h window) and as plain templated
 * text (inside it); only the message kind differs.
 */
import { formatMoney } from "../pipeline/reply.js";

export const SERVICE_WINDOW_HOURS = 24;

const BODIES = {
  1: { template: "quote_reminder_1", body: "Hello! A quick reminder about your quote from {business}: {amount}.{link} Reply STOP to stop reminders." },
  2: { template: "quote_reminder_2", body: "Last reminder about your quote from {business}: {amount}.{link} Reply STOP to stop reminders." },
} as const;

export interface ChaserParams {
  business: string;
  amount: string;
  link?: string;
}

export function chaserParams(business: string, quote: { total: number; currency: string }, link?: string): ChaserParams {
  return { business, amount: formatMoney(quote.total, quote.currency), ...(link && { link }) };
}

export function renderChaser(n: 1 | 2, p: ChaserParams): { template: string; text: string } {
  const b = BODIES[n];
  return {
    template: b.template,
    text: b.body.replace("{business}", () => p.business).replace("{amount}", () => p.amount).replace("{link}", () => (p.link ? ` Pay here: ${p.link}.` : "")),
  };
}
