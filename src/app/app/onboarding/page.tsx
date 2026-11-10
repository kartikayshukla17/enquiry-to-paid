"use client";

import { useState } from "react";
import { randomOrgSlug } from "@/lib/org-slug";

export default function CreateYourBusinessPage() {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/auth/organization/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, slug: randomOrgSlug(trimmed) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? "Could not create your business. Please try again.");
      window.location.href = "/app";
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "failed");
      setBusy(false);
    }
  }

  const input = "w-full border-2 border-ink bg-board px-3.5 py-2.5 text-[0.95rem] text-ink placeholder:text-ink/60";
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 px-5 py-10">
      <h1 className="painted font-display text-[clamp(1.95rem,6vw,3rem)] leading-[0.95] uppercase tracking-[-0.02em]">
        Create your business
      </h1>
      <p className="text-sm text-board/85">One business, one WhatsApp number, one rate card. Fictional data only.</p>
      <section className="panel flex flex-col gap-4 p-5">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            className={input}
            required
            placeholder="Business name"
            aria-label="Business name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={busy || !name.trim()} className="font-display border-2 border-ink bg-gold px-5 py-2.5 text-lg uppercase tracking-[0.04em] text-ink disabled:opacity-60">
            {busy ? "Creating…" : "Create business"}
          </button>
        </form>
        {err && <p role="alert" className="text-sm font-semibold text-signal-deep">{err}</p>}
      </section>
    </main>
  );
}
