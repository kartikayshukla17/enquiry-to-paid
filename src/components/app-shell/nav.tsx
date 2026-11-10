"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeNavKey, APP_NAV_ITEMS } from "@/lib/app-nav";

/** Inbox / Quotes / Escalations nav, used by the console shell layout. Wraps on narrow widths
 *  (375px) instead of scrolling horizontally. */
export function AppNav() {
  const pathname = usePathname();
  const active = activeNavKey(pathname);

  return (
    <nav aria-label="Console" className="flex flex-wrap gap-2">
      {APP_NAV_ITEMS.map((item) => {
        const isActive = item.key === active;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`font-display border-2 border-ink px-3.5 py-2 text-sm uppercase tracking-[0.03em] ${
              isActive ? "bg-gold text-ink" : "bg-board text-ink hover:bg-board-dim"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
