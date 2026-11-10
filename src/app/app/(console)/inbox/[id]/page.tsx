"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { EmptyState, ErrorState, LoadingState } from "@/components/app-shell/states";

/** Mirrors agent/src/server/app.ts's AppThreadDetail / AppLedgerEntryView (V4) — the site doesn't
 *  import agent TS across the package boundary, so this is a small site-local copy of the same
 *  shapes (same precedent as inbox/page.tsx's ThreadSummary mirror). */
type ThreadDetail = {
  id: string;
  state: string;
  createdAt: string;
  customerId: string;
  fields: unknown;
  maskedCustomerRef: string;
  lastMessageSummary: string | null;
};
type LedgerEntryView = {
  seq: number;
  at: string;
  type: string;
  payload: unknown;
  rateCardHash: string | null;
  modelId: string | null;
  provider: string | null;
  region: string | null;
  costMinor: number | null;
  summary: string;
};
type ThreadDetailResponse = { thread: ThreadDetail; entries: LedgerEntryView[] };
// undefined: loading. null: a real fetch/network error. "not_found": the id 404s (wrong tenant or
// nonexistent alike) — a distinct, calmer state from a network error, never a crash.
type DetailState = ThreadDetailResponse | null | undefined | "not_found";

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
 * V4: the thread detail screen. Shows the thread's state and masked customer reference, then every
 * ledger entry oldest-first (the agent already returns them `seq ASC`), each with its raw row
 * (type, timestamp, seq, payload — an internal owner tool, so the owner seeing the raw ledger
 * payload is the point) alongside the same one-line description the inbox list uses for its last
 * message. Does not attempt V5's chain-verify badge or structured quote-line rendering.
 */
export default function ThreadDetailPage() {
  const params = useParams<{ id: string }>();
  const threadId = params.id;
  const [state, setState] = useState<DetailState>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/app/threads/${encodeURIComponent(threadId)}`);
        if (r.status === 404) {
          if (!cancelled) setState("not_found");
          return;
        }
        if (!r.ok) throw new Error("request failed");
        const j = (await r.json()) as ThreadDetailResponse;
        if (!cancelled) setState(j);
      } catch {
        if (!cancelled) setState(null);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  if (state === undefined) return <LoadingState label="Loading thread…" />;
  if (state === null) return <ErrorState title="Could not load this thread" body="Check your connection and reload the page." />;
  if (state === "not_found") {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState title="Thread not found" body="This enquiry does not exist, or belongs to another business." />
        <Link href="/app/inbox" className="font-display text-sm uppercase tracking-[0.03em] text-ink underline">
          Back to inbox
        </Link>
      </div>
    );
  }

  const { thread, entries } = state;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/app/inbox" className="font-display text-sm uppercase tracking-[0.03em] text-ink underline">
        Back to inbox
      </Link>

      <div className="panel flex flex-col gap-1 border-2 border-ink p-4">
        <div className="flex items-center gap-2">
          <span className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">{STATE_LABELS[thread.state] ?? thread.state}</span>
          <span className="font-mono text-sm text-ink/60">{thread.maskedCustomerRef}</span>
        </div>
        <p className="text-sm text-ink">{thread.lastMessageSummary ?? "No messages yet"}</p>
      </div>

      {entries.length === 0 ? (
        <EmptyState title="No messages yet" body="Nothing has happened on this thread yet." />
      ) : (
        <ol className="flex flex-col gap-3">
          {entries.map((e) => (
            <li key={e.seq} className="panel flex flex-col gap-2 border-2 border-ink p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">
                  #{e.seq} · {e.type}
                </span>
                <span className="text-xs text-ink/50">{formatTimestamp(e.at)}</span>
              </div>
              <p className="text-sm text-ink">{e.summary}</p>
              <details className="text-xs text-ink/60">
                <summary className="cursor-pointer select-none">Raw ledger row</summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(e.payload, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
