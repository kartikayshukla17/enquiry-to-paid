const BENCHMARKS = [
  { who: "Intercom Fin", what: "$0.99 / resolution" },
  { who: "Zendesk", what: "$1.50–2.00 / resolution" },
  { who: "HubSpot Prospecting", what: "$1.00 / lead" },
  { who: "WhatsApp platforms, India", what: "₹1,350–5,000 / mo" },
  { who: "Per booked job", what: "nobody found" },
];

export function Pricing() {
  return (
    <section className="relative px-[max(1.25rem,env(safe-area-inset-left))] py-20 sm:py-24">
      <div className="mx-auto max-w-[78rem]">
        <div className="grid gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          <div>
            <h2 className="painted font-display max-w-[20ch] text-[clamp(1.95rem,5.2vw,3.5rem)] leading-[0.95] uppercase tracking-[-0.02em] [text-wrap:balance]">
              You pay out of what it brings in.
            </h2>

            <p className="painted-gold font-display mt-7 text-[clamp(2.25rem,7vw,3.75rem)] leading-none uppercase">
              Per booked job
            </p>

            <p className="mt-7 max-w-[50ch] text-board/85 sm:text-lg">
              Or a share of what gets collected. You can argue with ₹4,000 a
              month. Nobody argues with a cut of a booking that would not have
              existed.
            </p>

            <p className="mt-5 max-w-[50ch] text-board/75">
              That only works if the attribution is provable, so it gets built
              first: every enquiry, every quote, every booking it claims,
              timestamped and append-only. If the ledger cannot show the agent
              closed it, it is not billable.
            </p>

            <p className="mt-7 max-w-[50ch] border-t-2 border-signal/60 pt-4 text-sm leading-snug text-board/80">
              Not yet validated: whether owner-operators in NCR and the Gulf
              will accept revenue share at all. Five conversations before this
              goes on a real price page.
            </p>
          </div>

          <div className="panel self-start p-6 sm:p-8">
            <h3 className="font-display text-base uppercase tracking-[0.14em] text-ink/70">
              What outcome pricing looks like elsewhere
            </h3>
            <dl className="mt-6">
              {BENCHMARKS.map((b, i) => (
                <div
                  key={b.who}
                  className={`flex items-baseline justify-between gap-6 py-3 ${
                    i < BENCHMARKS.length - 1
                      ? "border-b border-dashed border-ink/25"
                      : ""
                  }`}
                >
                  <dt className="text-[0.975rem] text-ink/90">{b.who}</dt>
                  <dd className="nums font-display shrink-0 text-base text-ink">
                    {b.what}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-6 text-xs leading-snug text-ink/70">
              Outcome pricing exists, but only for support resolutions and
              leads. A first-half 2026 buyer survey put preference for it at 27
              percent.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
