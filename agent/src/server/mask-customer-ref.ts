/**
 * Masks a customer reference (a real phone number, decrypted server-side only, or the
 * simulator's non-phone-shaped ref such as "web-sim-customer") for display on the owner console.
 * V4's ticket text: "last 2-3 digits visible, never the full number, never nothing".
 *
 * The last `VISIBLE_TAIL` characters of the raw value are shown verbatim (a legitimate owner can
 * eyeball which thread is which); everything before that is replaced by a constant-width run of
 * mask characters, not one per masked character, so the output's length never reveals how long
 * the raw value was. The raw value itself must never be returned unmasked, and the output must
 * never be empty or blank.
 *
 * Pure and framework-free by design (no DB, no crypto) so it is directly unit-testable; the caller
 * is responsible for decrypting `customers.phone_enc` (see security/pii.ts) and must never let the
 * decrypted value escape anywhere except into this function.
 */
const MASK_PREFIX = "•".repeat(6);
const VISIBLE_TAIL = 3;

export function maskCustomerRef(raw: string): string {
  const tailLen = Math.min(VISIBLE_TAIL, raw.length);
  const tail = tailLen > 0 ? raw.slice(raw.length - tailLen) : "";
  return `${MASK_PREFIX}${tail}`;
}
