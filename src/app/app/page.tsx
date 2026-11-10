"use client";

import { useEffect, useState } from "react";

type Org = { id: string; name: string };
// undefined: still checking. null: no session (shouldn't happen past the middleware, but handled
// defensively). An empty array means the visitor has no business yet and belongs on /onboarding.
type OrgsState = Org[] | null | undefined;

export default function AppHomePage() {
  const [orgs, setOrgs] = useState<OrgsState>(undefined);

  useEffect(() => {
    fetch("/api/auth/get-session")
      .then((r) => (r.ok ? r.json() : null))
      .then((session) => {
        if (!session) {
          window.location.href = "/login";
          return null;
        }
        return fetch("/api/auth/organization/list").then((r) => (r.ok ? r.json() : []));
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

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 px-5 py-10">
      <h1 className="painted font-display text-[clamp(1.95rem,6vw,3rem)] leading-[0.95] uppercase tracking-[-0.02em]">
        You&apos;re in
      </h1>
      <section className="panel flex flex-col gap-3 p-5 text-ink">
        {orgs === undefined && <p className="text-sm">Loading…</p>}
        {orgs && orgs.length > 0 && (
          <>
            <p className="font-display text-2xl uppercase">{orgs[0]!.name}</p>
            <p className="text-sm text-ink/70">Empty for now.</p>
          </>
        )}
      </section>
    </main>
  );
}
