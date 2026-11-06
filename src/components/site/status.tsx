const LINES: { state: "done" | "now" | "next"; what: string }[] = [
  {
    state: "done",
    what: "Positioning, a competitor check run against live product and pricing pages, and a contract review clearing it to be built at all",
  },
  {
    state: "done",
    what: "The prior work that makes it credible: a config analyser running 14 rules with 132 passing tests, and a bilingual agent scoring real transcripts against a schema",
  },
  {
    state: "now",
    what: "One hour with one banquet owner, writing down how they actually price a Saturday in December",
  },
  {
    state: "next",
    what: "The rate-card kernel and its refusal path, in that order, before any autonomy is claimed",
  },
  {
    state: "next",
    what: "Per-language accuracy numbers on code-switched enquiries, published whatever they say",
  },
  {
    state: "next",
    what: "The attribution ledger, because the pricing model is void without it",
  },
];

const BADGE = {
  done: "bg-ink text-gold",
  now: "bg-signal-deep text-board",
  next: "border-2 border-board/45 text-board/80",
} as const;

const LABEL = { done: "Done", now: "Now", next: "Next" } as const;

export function Status() {
  return (
    <section className="relative px-[max(1.25rem,env(safe-area-inset-left))] py-20 sm:py-24">
      <div className="mx-auto max-w-[78rem]">
        <h2 className="painted font-display max-w-[24ch] text-[clamp(1.95rem,5.2vw,3.5rem)] leading-[0.95] uppercase tracking-[-0.02em] [text-wrap:balance]">
          None of this is shipped yet.
        </h2>

        <p className="mt-5 inline-block bg-signal-deep px-3 py-1 font-display text-sm uppercase tracking-[0.12em] text-board">
          Nothing to log into
        </p>

        <p className="mt-6 max-w-[52ch] text-board/85 sm:text-lg">
          There is no product to log into, no customer to quote at you, and no
          screenshot of a thing that works. Here is the actual state, dated 7
          November 2026.
        </p>

        <ul className="mt-12 divide-y-2 divide-faded/25 border-y-2 border-faded/25">
          {LINES.map((l) => (
            <li
              key={l.what}
              className="flex flex-col gap-3 py-5 sm:flex-row sm:items-baseline sm:gap-6"
            >
              <span
                className={`font-display w-[4.5rem] shrink-0 px-3 py-1 text-center text-xs uppercase tracking-[0.12em] ${BADGE[l.state]}`}
              >
                {LABEL[l.state]}
              </span>
              <span className="max-w-[62ch] text-[1.0125rem] leading-snug text-board/90">
                {l.what}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
