import type { ExtractedFields } from "../kernel/types.js";
import { formatDate } from "../pipeline/reply.js";

/** "banquet, 13 Jun 2027, 300 guests": only typed fields, formatted by code. */
export function describeAsk(f: Partial<ExtractedFields>): string {
  const parts: string[] = [];
  if (f.service) parts.push(f.service);
  if (f.package) parts.push(f.package);
  if (f.date) parts.push(formatDate(f.date));
  if (f.guestCount !== undefined) parts.push(`${f.guestCount} guests`);
  if (f.quantity !== undefined) parts.push(`${f.quantity} units`);
  if (f.hours !== undefined) parts.push(`${f.hours} hours`);
  if (f.distanceKm !== undefined) parts.push(`${f.distanceKm} km`);
  if (f.locality) parts.push(f.locality);
  return parts.length > 0 ? parts.join(", ") : "details not captured yet";
}

export const refOf = (tenantSeq: number): string => `R${tenantSeq}`;
