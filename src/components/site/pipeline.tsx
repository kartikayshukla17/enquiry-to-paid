import { PointingHand } from "@/components/site/icons";

const STEPS = [
  {
    n: "1",
    head: "Answered",
    body: "Reads the message as it actually arrives — Hindi mixed with English, a voice note, a forwarded floor plan — and asks only for what is missing.",
    now: "Today: answered at 11 the next morning",
  },
  {
    n: "2",
    head: "Priced",
    body: "Prices the job off your own rate card: date class, guest count, menu tier, travel, overtime. Sends a real number with the terms attached.",
    now: "Today: you have to sit down and work it out",
  },
  {
    n: "3",
    head: "Booked",
    body: "Follows up on its own schedule, holds the date, answers the three questions that always come next, and takes the deposit.",
    now: "Today: the quote is sent, then forgotten",
  },
  {
    n: "4",
    head: "Paid",
    body: "Invoices on the milestone, reminds before the due date, and escalates to you only when a human genuinely has to step in.",
    now: "Today: chased on WhatsApp, badly, weeks late",
  },
];

export function Pipeline() {
  return (
    <section className="relative px-[max(1.25rem,env(safe-area-inset-left))] py-20 sm:py-24">
      <div className="mx-auto max-w-[78rem]">
        <h2 className="painted font-display max-w-[26ch] text-[clamp(1.95rem,5.2vw,3.5rem)] leading-[0.95] uppercase tracking-[-0.02em] [text-wrap:balance]">
          Four things have to happen. Software today does the first and the last.
        </h2>

        <p className="mt-6 max-w-[52ch] text-board/80 sm:text-lg">
          One agent on one number carries all four. Not a suite with eight
          modules and a dashboard you will never open.
        </p>

        {/* One continuous board divided by painted keylines, not four cards. */}
        <div className="panel mt-12 grid grid-cols-1 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <div
              key={s.n}
              className={`flex flex-col gap-3 p-6 sm:p-7 ${
                i > 0
                  ? "border-t-2 border-dashed border-ink/30 lg:border-t-0 lg:border-l-2"
                  : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="font-display nums flex h-8 w-8 items-center justify-center bg-ink text-base text-gold">
                  {s.n}
                </span>
                <h3 className="font-display text-2xl uppercase tracking-[0.01em] text-ink">
                  {s.head}
                </h3>
              </div>
              <p className="text-[0.95rem] leading-snug text-ink/85">{s.body}</p>
              <p className="mt-auto flex items-start gap-2 pt-4 text-xs uppercase leading-snug tracking-[0.06em] text-signal-deep">
                <PointingHand className="mt-px h-3.5 w-5 shrink-0" />
                {s.now}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
