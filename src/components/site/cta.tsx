"use client";

import { useState } from "react";
import { Brush } from "@/components/site/icons";

type State = "idle" | "error" | "sent";

export function Cta() {
  const [number, setNumber] = useState("");
  const [state, setState] = useState<State>("idle");

  const digits = number.replace(/[^\d]/g, "");
  const empty = digits.length === 0;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (digits.length < 8 || digits.length > 15) {
      setState("error");
      return;
    }
    setState("sent");
  }

  return (
    <section
      id="rate-card"
      className="relative px-[max(1.25rem,env(safe-area-inset-left))] py-20 sm:py-28"
    >
      <div className="sodium-low" aria-hidden="true" />
      <div className="relative mx-auto max-w-[52rem] text-center">
        <h2 className="painted font-display text-[clamp(2.1rem,6.4vw,4.25rem)] leading-[0.92] uppercase tracking-[-0.02em] [text-wrap:balance]">
          Send your rate card. Get your agent.
        </h2>

        <p className="font-deva mt-5 text-[clamp(1.05rem,3vw,1.5rem)] leading-tight text-gold">
          अपना रेट कार्ड भेजिए।
        </p>

        <p className="mx-auto mt-7 max-w-[46ch] text-board/90 sm:text-lg">
          A photo of the board on your wall is enough. The first build goes to
          whoever can sit with me for an hour and explain how they price a
          Saturday.
        </p>

        {state === "sent" ? (
          <div className="panel keyline mx-auto mt-11 max-w-[34rem] p-7 text-left">
            <p className="font-display text-xl uppercase tracking-[0.01em] text-ink">
              Nothing was sent.
            </p>
            <p className="mt-3 text-[0.975rem] leading-snug text-ink/80">
              There is no backend behind this page yet, so your number went
              nowhere and was not stored. That is the honest answer rather than
              a thank-you screen that lies to you.
            </p>
            <p className="mt-4 text-[0.975rem] leading-snug text-ink/80">
              Until there is one, reach Kartikay Shukla on LinkedIn and paste
              the same number there.
            </p>
            <button
              type="button"
              onClick={() => {
                setNumber("");
                setState("idle");
              }}
              className="font-display mt-6 inline-flex items-center gap-2 border-2 border-ink px-5 py-2.5 text-sm uppercase tracking-[0.06em] text-ink transition-colors hover:bg-ink hover:text-gold"
            >
              Start over
            </button>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            noValidate
            className="mx-auto mt-11 flex max-w-[34rem] flex-col gap-3 sm:flex-row"
          >
            <div className="flex-1 text-left">
              <label htmlFor="wa" className="sr-only">
                Your WhatsApp number
              </label>
              <input
                id="wa"
                name="wa"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={number}
                placeholder="+91 98••• •••••"
                aria-invalid={state === "error"}
                aria-describedby={state === "error" ? "wa-error" : undefined}
                onChange={(e) => {
                  setNumber(e.target.value);
                  if (state === "error") setState("idle");
                }}
                className={`nums w-full border-[3px] bg-enamel-deep px-4 py-3.5 text-lg text-board placeholder:text-board/65 ${
                  state === "error" ? "border-signal" : "border-board/70"
                }`}
              />
              {state === "error" && (
                <p
                  id="wa-error"
                  className="mt-2 text-sm leading-snug text-signal"
                >
                  That does not look like a phone number. Include the country
                  code, 8 to 15 digits.
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={empty}
              className="font-display inline-flex h-fit items-center justify-center gap-2.5 bg-gold px-7 py-4 text-lg uppercase tracking-[0.015em] text-ink shadow-[0_12px_24px_-10px_rgba(4,14,38,0.7)] transition-transform duration-200 ease-out hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:bg-board-dim disabled:text-ink/70 disabled:shadow-none disabled:hover:translate-y-0"
            >
              Send
              <Brush className="h-5 w-5" />
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t-2 border-faded/25 px-[max(1.25rem,env(safe-area-inset-left))] pt-12 pb-32 sm:pb-28">
      <div className="mx-auto flex max-w-[78rem] flex-col gap-3 text-sm leading-snug text-board/70">
        <p className="max-w-[72ch]">
          Built in public by Kartikay Shukla. Every figure on this page comes
          from a public product page, a third-party buyer guide, or a named
          benchmark, and is dated November 2026. Where something is a
          vendor&rsquo;s own claim or not yet verified, the page says so.
        </p>
        <p className="max-w-[72ch]">
          The conversations shown are worked examples with a fictional business
          name. No real customer conversation appears on this page.
        </p>
      </div>
    </footer>
  );
}
