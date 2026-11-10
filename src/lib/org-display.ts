/**
 * The tenant name shown in the console shell's header. A business always has a `name` by the time
 * it reaches the shell (onboarding requires one), but this stays defensive against a blank or
 * missing value rather than painting an empty header.
 */

/** The org's name, trimmed, or a generic fallback when it is missing or blank. */
export function orgDisplayName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : "Your business";
}
