"use client";

import { useCallback, useEffect, useState } from "react";
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

/** V6: states where the owner can take over -- `refused` (the agent is waiting on the owner) and
 *  `paused_owner` (already taken over). Any other state has nothing to take over. */
const TAKEOVER_STATES = new Set(["refused", "paused_owner"]);

/**
 * V4: the thread detail screen. Shows the thread's state and masked customer reference, then every
 * ledger entry oldest-first (the agent already returns them `seq ASC`), each with its raw row
 * (type, timestamp, seq, payload — an internal owner tool, so the owner seeing the raw ledger
 * payload is the point) alongside the same one-line description the inbox list uses for its last
 * message. Does not attempt V5's chain-verify badge or structured quote-line rendering.
 *
 * V6 adds the takeover/reply/handback controls: a reply box (+ Send) while the thread is `refused`
 * or `paused_owner` -- calling POST .../takeover, which both takes the thread over and sends the
 * reply, the same "take over and reply" action the owner-channel's `ownerReplyInTxn` already is --
 * and a "Hand back" button (POST .../handback) only while `paused_owner`. Either action refetches
 * this same thread detail so the new ledger rows and state show up, rather than guessing locally.
 */
export default function ThreadDetailPage() {
  const params = useParams<{ id: string }>();
  const threadId = params.id;
  const [state, setState] = useState<DetailState>(undefined);
  const [replyText, setReplyText] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/app/threads/${encodeURIComponent(threadId)}`);
      if (r.status === 404) {
        setState("not_found");
        return;
      }
      if (!r.ok) throw new Error("request failed");
      const j = (await r.json()) as ThreadDetailResponse;
      setState(j);
    } catch {
      setState(null);
    }
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendReply() {
    const text = replyText.trim();
    if (!text || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/app/threads/${encodeURIComponent(threadId)}/takeover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error("request failed");
      setReplyText("");
      await load();
    } catch {
      setActionError("Could not send the reply. Check your connection and try again.");
    } finally {
      setActionBusy(false);
    }
  }

  async function handBack() {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/app/threads/${encodeURIComponent(threadId)}/handback`, { method: "POST" });
      if (!r.ok) throw new Error("request failed");
      await load();
    } catch {
      setActionError("Could not hand back this thread. Check your connection and try again.");
    } finally {
      setActionBusy(false);
    }
  }

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
  const canTakeOver = TAKEOVER_STATES.has(thread.state);
  const isPaused = thread.state === "paused_owner";

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

      {canTakeOver && (
        <div className="panel flex flex-col gap-2 border-2 border-ink p-4">
          <label htmlFor="owner-reply" className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">
            {isPaused ? "Send another reply" : "Take over and reply"}
          </label>
          <textarea
            id="owner-reply"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            rows={3}
            placeholder="Type a reply to send to the customer…"
            className="border-2 border-ink bg-board p-2 text-sm text-ink"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void sendReply()}
              disabled={actionBusy || !replyText.trim()}
              className="font-display border-2 border-ink bg-gold px-4 py-2 text-sm uppercase tracking-[0.03em] text-ink disabled:opacity-50"
            >
              Send
            </button>
            {isPaused && (
              <button
                type="button"
                onClick={() => void handBack()}
                disabled={actionBusy}
                className="font-display border-2 border-ink bg-board px-4 py-2 text-sm uppercase tracking-[0.03em] text-ink hover:bg-board-dim disabled:opacity-50"
              >
                Hand back
              </button>
            )}
          </div>
          {actionError && (
            <p role="alert" className="text-sm text-signal-deep">
              {actionError}
            </p>
          )}
        </div>
      )}

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
