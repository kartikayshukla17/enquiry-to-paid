"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EmptyState, ErrorState, LoadingState } from "@/components/app-shell/states";
import { filterThreadsByState, THREAD_STATES, type ThreadStateFilter } from "@/lib/thread-filter";

/** Mirrors agent/src/server/app.ts's AppThreadSummary (V4) — the site doesn't import agent TS
 *  across the package boundary, so this is a small site-local copy of the same shape. */
type ThreadSummary = {
  id: string;
  state: string;
  createdAt: string;
  customerId: string;
  maskedCustomerRef: string;
  lastMessageSummary: string | null;
};
type ThreadsState = ThreadSummary[] | null | undefined;

const STATE_LABELS: Record<string, string> = {
  open: "Open",
  quoted: "Quoted",
  refused: "Refused",
  paused_owner: "Paused",
  booked: "Booked",
  collected: "Collected",
  closed: "Closed",
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * V4: the real inbox. Every WhatsApp enquiry run through the playground becomes a thread here, with
 * its state, a masked customer reference (the last 2-3 digits only — never the full number, never
 * nothing), a one-line summary of the last ledger entry, and when it last moved. Filterable by
 * `threads.state`; filtering is client-side over the already-fetched list, which is fine at v1
 * scale. Each row links to the thread detail screen.
 */
export default function InboxPage() {
  const [threads, setThreads] = useState<ThreadsState>(undefined);
  const [filter, setFilter] = useState<ThreadStateFilter>("all");

  useEffect(() => {
    fetch("/api/app/threads")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("request failed"))))
      .then((j: { threads: ThreadSummary[] }) => setThreads(j.threads))
      .catch(() => setThreads(null));
  }, []);

  if (threads === undefined) return <LoadingState label="Loading inbox…" />;
  if (threads === null) return <ErrorState title="Could not load the inbox" body="Check your connection and reload the page." />;
  if (threads.length === 0) return <EmptyState title="Inbox is empty" body="New WhatsApp enquiries will show up here." />;

  const visible = filterThreadsByState(threads, filter);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="inbox-state-filter" className="text-sm font-semibold uppercase tracking-[0.03em] text-ink/70">
          Filter
        </label>
        <select
          id="inbox-state-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value as ThreadStateFilter)}
          className="border-2 border-ink bg-board px-3 py-1.5 text-sm"
        >
          <option value="all">All ({threads.length})</option>
          {THREAD_STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s] ?? s}
            </option>
          ))}
        </select>
      </div>

      {visible.length === 0 ? (
        <EmptyState title="No threads in this state" body="Try a different filter." />
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((t) => (
            <li key={t.id}>
              <Link
                href={`/app/inbox/${encodeURIComponent(t.id)}`}
                className="panel flex flex-col gap-1 border-2 border-ink p-4 hover:bg-board-dim sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">{STATE_LABELS[t.state] ?? t.state}</span>
                    <span className="font-mono text-sm text-ink/60">{t.maskedCustomerRef}</span>
                  </div>
                  <p className="text-sm text-ink">{t.lastMessageSummary ?? "No messages yet"}</p>
                </div>
                <span className="text-xs text-ink/50">{formatTimestamp(t.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
