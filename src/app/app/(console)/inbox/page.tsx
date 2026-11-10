"use client";

import { useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/app-shell/states";

/** Mirrors agent/src/server/app.ts's AppThreadSummary — the site doesn't import agent TS across
 *  the package boundary, so this is a small site-local copy of the same shape (V3b). */
type ThreadSummary = { id: string; state: string; createdAt: string; customerId: string };
type ThreadsState = ThreadSummary[] | null | undefined;

/**
 * V3c's stub: proves the shell works end to end by calling the real, tenant-scoped
 * GET /api/app/threads (V3b) and rendering the shared empty state for the happy path every demo
 * tenant is in today. V4 replaces this page's body with the real thread list.
 */
export default function InboxPage() {
  const [threads, setThreads] = useState<ThreadsState>(undefined);

  useEffect(() => {
    fetch("/api/app/threads")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("request failed"))))
      .then((j: { threads: ThreadSummary[] }) => setThreads(j.threads))
      .catch(() => setThreads(null));
  }, []);

  if (threads === undefined) return <LoadingState label="Loading inbox…" />;
  if (threads === null) return <ErrorState title="Could not load the inbox" body="Check your connection and reload the page." />;
  if (threads.length === 0) return <EmptyState title="Inbox is empty" body="New WhatsApp enquiries will show up here." />;

  return (
    <div className="panel p-8 text-center text-sm text-ink/70">
      {threads.length} {threads.length === 1 ? "enquiry" : "enquiries"} waiting. The full inbox view is coming soon.
    </div>
  );
}
