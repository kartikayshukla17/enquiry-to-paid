"use client";

import { BlurFade } from "@/components/ui/blur-fade";
import { Brush } from "@/components/site/icons";
import { BrushStroke } from "@/components/site/brush-stroke";

const LANGUAGES = [
  { label: "English", font: "font-body" },
  { label: "हिन्दी", font: "font-deva" },
  { label: "اردو", font: "font-arabic" },
  { label: "മലയാളം", font: "font-body" },
  { label: "Tagalog", font: "font-body" },
  { label: "العربية", font: "font-arabic" },
];

export function Hero() {
  return (
    <section className="relative px-[max(1.25rem,env(safe-area-inset-left))] pt-14 pb-16 sm:pt-20 sm:pb-20">
      <div className="mx-auto grid max-w-[78rem] items-start gap-10 lg:grid-cols-[1.08fr_0.92fr] lg:gap-14">
        <div className="min-w-0">
          <BlurFade delay={0.05} inView={false} offset={14} blur="8px">
            <h1 className="painted font-display text-[clamp(2.5rem,7.6vw,5.5rem)] leading-[0.9] tracking-[-0.025em] uppercase [text-wrap:balance]">
              The message you missed
              <br />
              at <span className="painted-gold">9:40</span> booked
              <br />
              somewhere else.
            </h1>
          </BlurFade>

          <BlurFade delay={0.28} inView={false} offset={10} blur="6px">
            <p className="font-deva mt-6 text-[clamp(1.2rem,3.4vw,1.75rem)] leading-tight text-gold">
              जो मैसेज छूटा, वो बुकिंग गई।
            </p>
          </BlurFade>

          <BlurFade delay={0.42} inView={false} offset={10} blur="4px">
            <p className="mt-7 max-w-[44ch] text-[1.0625rem] leading-relaxed text-board/90 sm:text-lg">
              One WhatsApp number answers every enquiry in the language it
              arrives in, prices the job the same hour from rules you set once,
              chases the quote, and collects the money. Nobody on your side has
              to be awake.
            </p>
          </BlurFade>

          <BlurFade delay={0.56} inView={false} offset={8}>
            <p className="mt-7 max-w-[42ch] border-t-2 border-gold/70 pt-4 text-[0.975rem] leading-snug text-board/85">
              It does not exist yet. I am building it with one business at a
              time, in public, and the first one gets it free.
            </p>
          </BlurFade>

          <BlurFade delay={0.64} inView={false} offset={8}>
            <a
              href="#rate-card"
              className="font-display mt-8 inline-flex items-center gap-2.5 bg-gold px-6 py-3.5 text-lg uppercase tracking-[0.015em] text-ink shadow-[0_12px_24px_-10px_rgba(4,14,38,0.65)] transition-transform duration-200 ease-out hover:-translate-y-0.5 active:translate-y-0 lg:hidden"
            >
              Send your rate card
              <Brush className="h-5 w-5" />
            </a>
          </BlurFade>

          <BlurFade delay={0.72} inView={false} offset={6}>
            <ul className="mt-9 flex flex-wrap gap-2">
              {LANGUAGES.map((l) => (
                <li
                  key={l.label}
                  className={`${l.font} border-2 border-faded/55 px-3 py-1 text-sm text-board/85`}
                >
                  {l.label}
                </li>
              ))}
            </ul>
          </BlurFade>
        </div>

        <BlurFade
          delay={0.34}
          inView={false}
          offset={18}
          blur="10px"
          className="min-w-0"
        >
          <RateBoard />
        </BlurFade>
      </div>
    </section>
  );
}

function RateBoard() {
  return (
    <div id="board" className="panel keyline relative p-5 sm:p-7">
      <p className="font-display text-sm uppercase tracking-[0.18em] text-ink/65">
        Kohli Banquets · rate board
      </p>

      <div className="mt-5 border-b-2 border-dashed border-ink/25 pb-5">
        <div className="bg-ink/8 max-w-[92%] px-4 py-3">
          <p className="text-[0.95rem] leading-snug text-ink">
            18 Dec chahiye, 250 log honge. Veg only. Budget kya rahega?
          </p>
          <p className="nums mt-1.5 text-xs text-ink/65">9:41 pm · WhatsApp</p>
        </div>
      </div>

      <div className="pt-5">
        <p className="font-display text-sm uppercase tracking-[0.14em] text-ink/70">
          Saturday, December rate
        </p>
        <p className="nums font-display relative mt-1 inline-flex items-baseline gap-1 text-[clamp(2.4rem,8vw,3.9rem)] leading-none text-ink">
          <span className="text-[0.55em] text-ink/75">₹</span>
          3,80,000
          <BrushStroke className="pointer-events-none absolute -bottom-2 left-0 h-3 w-full text-gold" />
        </p>

        <dl className="nums mt-7 space-y-2 text-[0.925rem] text-ink/85">
          <div className="flex justify-between gap-4 border-b border-ink/15 pb-2">
            <dt>Veg thali × 250</dt>
            <dd className="shrink-0">₹1,180 / plate</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-ink/15 pb-2">
            <dt>Hall rental, Sat peak</dt>
            <dd className="shrink-0">₹85,000</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Holds the date 48 hours</dt>
            <dd className="shrink-0">₹50,000 deposit</dd>
          </div>
        </dl>

        <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink/75">
          <span className="font-display bg-ink px-2 py-0.5 text-xs uppercase tracking-[0.1em] text-gold">
            Quoted from your rules
          </span>
          <span className="nums">7 seconds · nobody approved it</span>
        </p>
      </div>

      {/* The primary action sits on the board's bottom edge, where the price is. */}
      <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3 border-t-2 border-ink/80 pt-5">
        <a
          href="#rate-card"
          className="font-display inline-flex items-center gap-2.5 bg-gold px-6 py-3.5 text-lg uppercase tracking-[0.015em] text-ink shadow-[0_12px_24px_-10px_rgba(4,14,38,0.7)] transition-transform duration-200 ease-out hover:-translate-y-0.5 active:translate-y-0"
        >
          Send your rate card
          <Brush className="h-5 w-5" />
        </a>
        <span className="text-xs leading-snug text-ink/65">
          A photo of your board is enough
        </span>
      </div>

      <p className="mt-5 text-xs leading-snug text-ink/65">
        A worked example. No real customer conversation appears on this page.
      </p>
    </div>
  );
}
