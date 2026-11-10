"use client";

import { useEffect, useState } from "react";
import { AppNav } from "@/components/app-shell/nav";
import { ErrorState, LoadingState } from "@/components/app-shell/states";
import { orgDisplayName } from "@/lib/org-display";

type Org = { id: string; name: string };
// undefined: still checking. null: the session/org lookup failed (network/API error — the
// middleware already guarantees a session exists, so this is the defensive "agent unreachable"
// case). An empty array means the visitor has no business yet and belongs on /app/onboarding,
// which lives outside this route group and so is never wrapped by this nav/banner.
type OrgsState = Org[] | null | undefined;

/**
 * The shell every /app/* console screen shares: the "test environment" banner, the tenant name,
 * and the Inbox/Quotes/Escalations nav (V3c). Wraps /app/inbox, /app/quotes, /app/escalations and
 * the bare /app route (which redirects into /app/inbox) via this (console) route group — it does
 * NOT wrap /app/onboarding, which has no tenant yet.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const [orgs, setOrgs] = useState<OrgsState>(undefined);

  useEffect(() => {
    fetch("/api/auth/get-session")
      .then((r) => (r.ok ? r.json() : null))
      .then((session) => {
        if (!session) {
          window.location.href = "/login";
          return null;
        }
        return fetch("/api/auth/organization/list").then((r) => (r.ok ? r.json() : Promise.reject(new Error("could not load your business"))));
      })
      .then((list: Org[] | null) => {
        if (list === null) return;
        if (list.length === 0) {
          window.location.href = "/app/onboarding";
          return;
        }
        setOrgs(list);
      })
      .catch(() => setOrgs(null));
  }, []);

  if (orgs === undefined) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-5 py-10">
        <LoadingState label="Loading your console…" />
      </main>
    );
  }

  if (orgs === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-5 py-10">
        <ErrorState title="Could not load your console" body="Check your connection and reload the page." />
      </main>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col">
      <div className="panel flex items-center justify-center gap-1 border-b-4 border-gold px-5 py-2 text-center text-xs font-semibold uppercase tracking-[0.04em]">
        <span className="text-signal-deep">Test environment.</span>
        <span>Fictional data only.</span>
      </div>
      <header className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="painted font-display text-xl uppercase tracking-[-0.01em]">{orgDisplayName(orgs[0]?.name)}</p>
        <AppNav />
      </header>
      <main className="flex-1 px-5 pb-10">{children}</main>
    </div>
  );
}
