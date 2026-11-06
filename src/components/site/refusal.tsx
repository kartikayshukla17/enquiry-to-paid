const PARTS = [
  {
    role: "The model only reads",
    body: "It pulls the date, the guest count, the service and the language out of a messy message. Cheap to be wrong here, because the next step checks it.",
  },
  {
    role: "The rules decide the money",
    body: "Your rate card, approved once. Same inputs, same quote, every time, with a line-by-line reason for how it got there.",
  },
  {
    role: "It says when it cannot",
    body: "No rule covers 400 guests on a December Saturday with outside catering? It holds the date and hands you a one-tap draft instead of guessing.",
  },
];

export function Refusal() {
  return (
    <section className="relative px-[max(1.25rem,env(safe-area-inset-left))] py-20 sm:py-24">
      <div className="mx-auto max-w-[78rem]">
        <div className="grid gap-12 lg:grid-cols-[1fr_0.85fr] lg:gap-16">
          <div>
            <h2 className="painted font-display max-w-[20ch] text-[clamp(1.95rem,5.2vw,3.5rem)] leading-[0.95] uppercase tracking-[-0.02em] [text-wrap:balance]">
              It will not invent a price.
            </h2>

            <p className="mt-6 max-w-[50ch] text-board/85 sm:text-lg">
              A wrong price is not a funny screenshot. It is a number your
              customer will hold you to. That is the real reason every other
              tool keeps a human in the loop — and the only way past it is to
              take the money decision away from the model entirely.
            </p>

            <dl className="mt-10 space-y-7">
              {PARTS.map((p) => (
                <div key={p.role} className="border-t-2 border-faded/35 pt-5">
                  <dt className="font-display text-xl uppercase tracking-[0.015em] text-gold">
                    {p.role}
                  </dt>
                  <dd className="mt-2 max-w-[52ch] text-[0.975rem] leading-snug text-board/85">
                    {p.body}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="panel-dark keyline self-start p-6 sm:p-7">
            <p className="font-display text-sm uppercase tracking-[0.18em] text-board/75">
              When the rules run out
            </p>

            <div className="mt-6 space-y-3">
              <div className="max-w-[94%] bg-board/10 px-4 py-3">
                <p className="text-[0.95rem] leading-snug">
                  400 pax chahiye 18 Dec, aur caterer apna layenge. Rate batao.
                </p>
                <p className="nums mt-1.5 text-xs text-board/70">9:41 pm</p>
              </div>

              <div className="ml-auto max-w-[94%] bg-gold/18 px-4 py-3">
                <p className="text-[0.95rem] leading-snug">
                  400 guests on 18 December with outside catering — I can hold
                  the date, but I will not quote this one. Outside catering at
                  that size is not on your rate card.
                </p>
                <p className="nums mt-1.5 text-xs text-board/70">9:41 pm</p>
              </div>

              <div className="ml-auto max-w-[94%] bg-gold/18 px-4 py-3">
                <p className="text-[0.95rem] leading-snug">
                  Date held 24 hours. Mr. Kohli will send the number himself in
                  the morning.
                </p>
                <p className="nums mt-1.5 text-xs text-board/70">9:41 pm</p>
              </div>
            </div>

            <p className="font-display mt-6 inline-block border-2 border-signal px-3 py-1 text-xs uppercase tracking-[0.1em] text-signal">
              Refused to guess · you were told
            </p>

            <p className="mt-6 text-xs leading-snug text-board/70">
              Every quote, every booking it claims, and every rupee collected
              lands in an append-only ledger. That ledger is also how the
              pricing below stays honest.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
