/**
 * Turns a fictional business name into a Better Auth organization slug (unique, DB-enforced —
 * see agent/src/auth/schema.ts). The slug is an internal id, never shown to the owner, so a
 * random suffix is simplest way to dodge collisions rather than a check-then-retry round trip.
 */

/** Lowercase, hyphenated, punctuation stripped. Never empty. */
export function toSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "business";
}

/** `toSlug(name)` plus a short random suffix, so two owners can both call their business "Rose Court". */
export function randomOrgSlug(name: string, randomSuffix: () => string = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8)): string {
  return `${toSlug(name)}-${randomSuffix()}`;
}
