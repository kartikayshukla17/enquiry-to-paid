"use client";

import { useEffect, useState } from "react";

type Session = { user: { name: string; email: string; image?: string | null; emailVerified?: boolean }; session: { expiresAt: string } } | null;

export default function AccountPage() {
  const [s, setS] = useState<Session | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/get-session")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Auth server not reachable. Run `pnpm auth:web`."))))
      .then((j) => setS(j))
      .catch((e) => {
        setErr(e.message);
        setS(null);
      });
  }, []);

  async function out() {
    await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    window.location.href = "/login";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 px-5 py-10">
      <h1 className="painted font-display text-[clamp(1.95rem,6vw,3rem)] leading-[0.95] uppercase tracking-[-0.02em]">Account</h1>
      <section className="panel flex flex-col gap-3 p-5 text-ink">
        {s === undefined && <p className="text-sm">Checking session…</p>}
        {s === null && (
          <>
            <p className="text-sm">{err ?? "You are not signed in."}</p>
            <a href="/login" className="font-display w-fit border-2 border-ink bg-gold px-5 py-2 text-base uppercase text-ink">Go to sign in</a>
          </>
        )}
        {s && (
          <>
            <p className="text-sm">Signed in as</p>
            <p className="font-display text-2xl uppercase">{s.user.name}</p>
            <p className="nums text-sm">{s.user.email}</p>
            <p className="text-xs text-ink/70">Session expires {new Date(s.session.expiresAt).toLocaleString()}</p>
            <button onClick={out} className="font-display mt-2 w-fit border-2 border-ink px-5 py-2 text-base uppercase text-ink hover:bg-board-dim">Sign out</button>
          </>
        )}
      </section>
    </main>
  );
}
