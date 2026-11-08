"use client";

import { useState } from "react";

async function post(path: string, body: unknown) {
  const r = await fetch(`/api/auth/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message ?? "Request failed. Is `pnpm auth:web` running?");
  return j;
}

export default function LoginPage() {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"in" | "up">("in");
  const [f, setF] = useState({ name: "", email: "", password: "" });

  async function google() {
    setBusy(true);
    setErr(null);
    try {
      const j = await post("sign-in/social", { provider: "google", callbackURL: "/account" });
      if (!j.url) throw new Error("Google sign-in is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).");
      window.location.href = j.url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
      setBusy(false);
    }
  }

  async function email(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await (mode === "in"
        ? post("sign-in/email", { email: f.email, password: f.password })
        : post("sign-up/email", { name: f.name || f.email, email: f.email, password: f.password }));
      window.location.href = "/account";
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "failed");
      setBusy(false);
    }
  }

  const input = "w-full border-2 border-ink bg-board px-3.5 py-2.5 text-[0.95rem] text-ink placeholder:text-ink/60";
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 px-5 py-10">
      <h1 className="painted font-display text-[clamp(1.95rem,6vw,3rem)] leading-[0.95] uppercase tracking-[-0.02em]">Sign in</h1>
      <p className="text-sm text-board/85">Test environment. Fictional data only.</p>
      <section className="panel flex flex-col gap-4 p-5">
        <button onClick={google} disabled={busy} className="font-display border-2 border-ink bg-gold px-5 py-2.5 text-lg uppercase tracking-[0.04em] text-ink disabled:opacity-60">
          Continue with Google
        </button>
        <p className="text-center text-xs text-ink/70">or with email</p>
        <form onSubmit={email} className="flex flex-col gap-3">
          {mode === "up" && <input className={input} placeholder="Name" aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
          <input className={input} type="email" required placeholder="Email" aria-label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <input className={input} type="password" required minLength={8} placeholder="Password (8+ characters)" aria-label="Password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <button type="submit" disabled={busy} className="font-display border-2 border-ink px-5 py-2 text-base uppercase tracking-[0.04em] text-ink hover:bg-board-dim disabled:opacity-60">
            {mode === "in" ? "Sign in" : "Create account"}
          </button>
        </form>
        <button onClick={() => setMode(mode === "in" ? "up" : "in")} className="text-xs text-ink/75 underline">
          {mode === "in" ? "No account? Create one" : "Have an account? Sign in"}
        </button>
        {err && <p role="alert" className="text-sm font-semibold text-signal-deep">{err}</p>}
      </section>
    </main>
  );
}
