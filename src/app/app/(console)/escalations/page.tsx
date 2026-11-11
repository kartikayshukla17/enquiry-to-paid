"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EmptyState, ErrorState, LoadingState } from "@/components/app-shell/states";
import { formatRelativeAge } from "@/lib/relative-age";

/** Mirrors agent/src/server/app.ts's AppEscalationSummary (V6) -- the site doesn't import agent TS
 *  across the package boundary, so this is a small site-local copy of the same shape, same
 *  precedent as inbox/page.tsx's ThreadSummary mirror. */
type EscalationSummary = {
  tenantSeq: number;
  seq: number;
  threadId: string;
  reason: string;
  reasonText: string;
  ruleGap?: string;
  suggestion?: string;
  at: string;
  calledBack: boolean;
};
type EscalationsState = EscalationSummary[] | null | undefined;

/**
 * V6: the escalation queue. Every open escalation is the latest refusal on a thread the agent is
 * still waiting on the owner for -- a clarifying question never counts. Each row shows the
 * owner-facing reason (computed server-side, never re-derived here), the rate-card rule gap when the
 * agent's own card names one, how long ago it happened, and a link straight to V4's thread detail
 * screen, where the takeover/reply/handback controls live. Replaces the V3c static stub.
 */
export default function EscalationsPage() {
  const [escalations, setEscalations] = useState<EscalationsState>(undefined);

  useEffect(() => {
    fetch("/api/app/escalations")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("request failed"))))
      .then((j: { escalations: EscalationSummary[] }) => setEscalations(j.escalations))
      .catch(() => setEscalations(null));
  }, []);

  if (escalations === undefined) return <LoadingState label="Loading escalations…" />;
  if (escalations === null) return <ErrorState title="Could not load escalations" body="Check your connection and reload the page." />;
  if (escalations.length === 0) return <EmptyState title="No escalations" body="Enquiries that need your attention will show up here." />;

  return (
    <ul className="flex flex-col gap-2">
      {escalations.map((e) => (
        <li key={e.seq}>
          <Link
            href={`/app/inbox/${encodeURIComponent(e.threadId)}`}
            className="panel flex flex-col gap-1 border-2 border-ink p-4 hover:bg-board-dim sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">R{e.tenantSeq}</span>
                {e.calledBack && <span className="text-xs text-ink/50">call-back noted</span>}
              </div>
              <p className="text-sm text-ink">{e.reasonText}</p>
              {e.ruleGap && <p className="text-xs text-ink/60">Rule gap: {e.ruleGap}</p>}
            </div>
            <span className="text-xs text-ink/50">{formatRelativeAge(e.at)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
