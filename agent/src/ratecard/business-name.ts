/** A short business name to show on things customers see (payment pages, the reply). Cards label themselves
 * "FICTIONAL: <Business> sample rate card (...)"; this pulls just the honesty prefix and the name out of that. */
export function businessNameFromCard(card: unknown): string {
  const label = (card as { label?: unknown } | undefined)?.label;
  if (typeof label !== "string" || !label.trim()) return "FICTIONAL: Test business";
  const m = /^(FICTIONAL:\s*.+?)\s+sample rate card\b/i.exec(label);
  return m ? m[1]! : label;
}
