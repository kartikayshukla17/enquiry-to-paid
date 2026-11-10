"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EmptyState, ErrorState, LoadingState } from "@/components/app-shell/states";

/** Mirrors agent/src/server/app.ts's AppQuoteSummary (V5) — the site doesn't import agent TS across
 *  the package boundary, so this is a small site-local copy of the same shape (same precedent as
 *  inbox/page.tsx's ThreadSummary mirror). */
type QuoteSummary = {
  seq: number;
  threadId: string | null;
  type: "quote" | "owner_quote";
  at: string;
  total: number | null;
  currency: string | null;
  validUntil: string | null;
};
type QuotesState = QuoteSummary[] | null | undefined;

const TYPE_LABELS: Record<QuoteSummary["type"], string> = {
  quote: "Quote",
  owner_quote: "Owner price",
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Minor units -> a currency-prefixed display string. Formatting a stored number for display only —
 *  no arithmetic beyond dividing by 100, same ruling the quote detail page follows. */
function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/**
 * V5: the quotes list. Every `quote` and `owner_quote` ledger entry for this tenant, newest first.
 * Each row links to the quote detail screen, which renders the full line-item breakdown and the
 * chain-verify badge. This replaces the V3c static stub.
 */
export default function QuotesPage() {
  const [quotes, setQuotes] = useState<QuotesState>(undefined);

  useEffect(() => {
    fetch("/api/app/quotes")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("request failed"))))
      .then((j: { quotes: QuoteSummary[] }) => setQuotes(j.quotes))
      .catch(() => setQuotes(null));
  }, []);

  if (quotes === undefined) return <LoadingState label="Loading quotes…" />;
  if (quotes === null) return <ErrorState title="Could not load quotes" body="Check your connection and reload the page." />;
  if (quotes.length === 0) return <EmptyState title="No quotes yet" body="Quotes sent to customers will show up here." />;

  return (
    <ul className="flex flex-col gap-2">
      {quotes.map((q) => (
        <li key={q.seq}>
          <Link
            href={`/app/quotes/${q.seq}`}
            className="panel flex flex-col gap-1 border-2 border-ink p-4 hover:bg-board-dim sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">{TYPE_LABELS[q.type]}</span>
                <span className="font-mono text-sm text-ink/60">#{q.seq}</span>
              </div>
              <p className="text-sm text-ink">
                {q.total !== null && q.currency ? formatMoney(q.total, q.currency) : "Amount unavailable"}
                {q.validUntil ? ` · valid until ${formatTimestamp(q.validUntil)}` : ""}
              </p>
            </div>
            <span className="text-xs text-ink/50">{formatTimestamp(q.at)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
