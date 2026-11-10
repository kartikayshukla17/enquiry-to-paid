/**
 * The console shell's nav: items (V3c) plus the pure "which one is active" decision, pulled out so
 * it can be unit-tested directly (same precedent as src/lib/session-gate.ts). V4/V5/V6 each own the
 * page a route points at; this file only owns the nav's own structure and highlighting.
 */

export type AppNavKey = "inbox" | "quotes" | "escalations";

export interface AppNavItem {
  key: AppNavKey;
  href: string;
  label: string;
}

/** Inbox, Quotes, Escalations — in the order the ticket spec names them. */
export const APP_NAV_ITEMS: AppNavItem[] = [
  { key: "inbox", href: "/app/inbox", label: "Inbox" },
  { key: "quotes", href: "/app/quotes", label: "Quotes" },
  { key: "escalations", href: "/app/escalations", label: "Escalations" },
];

/**
 * Which nav item (if any) owns the current pathname: an exact match, or a nested path beneath it
 * (e.g. a future thread-detail route under /app/inbox). Never a bare prefix match, so
 * "/app/inboxoid" does not light up "Inbox".
 */
export function activeNavKey(pathname: string): AppNavKey | null {
  const item = APP_NAV_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  return item ? item.key : null;
}
