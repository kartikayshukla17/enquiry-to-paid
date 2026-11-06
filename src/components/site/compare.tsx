import { Tick, Cross, Half } from "@/components/site/icons";

type Cell = "yes" | "no" | "half";

const ROWS: {
  tool: string;
  instant: Cell;
  instantNote: string;
  prices: Cell;
  pricesNote: string;
  collects: Cell;
  collectsNote: string;
  price: string;
  wins: string;
  us?: boolean;
}[] = [
  {
    tool: "This",
    us: true,
    instant: "yes",
    instantNote: "six languages",
    prices: "yes",
    pricesNote: "or it abstains",
    collects: "yes",
    collectsNote: "with a ledger",
    price: "per booked job",
    wins: "Nothing yet. It isn't built.",
  },
  {
    tool: "HoneyBook",
    instant: "half",
    instantNote: "drafts the reply for you",
    prices: "no",
    pricesNote: "not advertised",
    collects: "yes",
    collectsNote: "sign-and-pay proposals",
    price: "from $29/mo",
    wins: "You want contracts, files and a real CRM",
  },
  {
    tool: "Dubsado",
    instant: "half",
    instantNote: "workflow-triggered",
    prices: "no",
    pricesNote: "not advertised",
    collects: "yes",
    collectsNote: "invoices on milestones",
    price: "per seat",
    wins: "You'll spend a weekend building workflows",
  },
  {
    tool: "Studio Ninja",
    instant: "no",
    instantNote: "no AI at all",
    prices: "no",
    pricesNote: "no",
    collects: "yes",
    collectsNote: "quotes and invoices",
    price: "per seat",
    wins: "You're a photographer who wants galleries wired in",
  },
  {
    tool: "AiSensy · Wati · Gallabox",
    instant: "yes",
    instantNote: "sub-second",
    prices: "no",
    pricesNote: "not advertised",
    collects: "half",
    collectsNote: "payment links, by hand",
    price: "₹1,350–5,000/mo",
    wins: "You need broadcasts and campaigns at volume",
  },
  {
    tool: "Gulf WhatsApp agents",
    instant: "yes",
    instantNote: "Gulf dialects",
    prices: "no",
    pricesNote: "not advertised",
    collects: "no",
    collectsNote: "hands off to a human",
    price: "SAR 300–3,000/mo",
    wins: "You want Najdi and Hejazi Arabic today",
  },
  {
    tool: "A good receptionist",
    instant: "half",
    instantNote: "until 7pm",
    prices: "yes",
    pricesNote: "yes",
    collects: "yes",
    collectsNote: "yes",
    price: "a salary",
    wins: "Honestly, often. Until the 40th enquiry that week.",
  },
];

function Mark({ state, note }: { state: Cell; note: string }) {
  const icon =
    state === "yes" ? (
      <Tick className="h-4 w-4 shrink-0 text-[#1b6b3a]" />
    ) : state === "no" ? (
      <Cross className="h-4 w-4 shrink-0 text-signal-deep" />
    ) : (
      <Half className="h-4 w-4 shrink-0 text-ink/45" />
    );
  return (
    <span className="flex items-start gap-2">
      {icon}
      <span className="text-[0.9rem] leading-snug text-ink/80">{note}</span>
    </span>
  );
}

export function Compare() {
  return (
    <section className="relative px-[max(1.25rem,env(safe-area-inset-left))] py-20 sm:py-24">
      <div className="mx-auto max-w-[78rem]">
        <h2 className="painted font-display max-w-[22ch] text-[clamp(1.95rem,5.2vw,3.5rem)] leading-[0.95] uppercase tracking-[-0.02em] [text-wrap:balance]">
          Everyone answers. Nobody quotes.
        </h2>

        <p className="mt-6 max-w-[54ch] text-board/85 sm:text-lg">
          Read it honestly: every one of these beats us at something today, and
          all of them exist. The column that matters is the third one.
        </p>

        <div className="panel mt-12 overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-left">
            <thead>
              <tr className="border-b-2 border-ink/80">
                {[
                  "Tool",
                  "Answers instantly",
                  "Sends a price on its own",
                  "Collects",
                  "Priced on",
                  "They win when",
                ].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="font-display px-4 py-3.5 text-xs uppercase tracking-[0.1em] text-ink/70"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr
                  key={r.tool}
                  className={`border-b border-ink/15 last:border-b-0 ${
                    r.us ? "bg-gold/25" : ""
                  }`}
                >
                  <th
                    scope="row"
                    className="font-display px-4 py-4 align-top text-base uppercase tracking-[0.01em] text-ink"
                  >
                    {r.tool}
                  </th>
                  <td className="px-4 py-4 align-top">
                    <Mark state={r.instant} note={r.instantNote} />
                  </td>
                  <td className="px-4 py-4 align-top">
                    <Mark state={r.prices} note={r.pricesNote} />
                  </td>
                  <td className="px-4 py-4 align-top">
                    <Mark state={r.collects} note={r.collectsNote} />
                  </td>
                  <td className="nums px-4 py-4 align-top text-[0.9rem] text-ink/75">
                    {r.price}
                  </td>
                  <td className="px-4 py-4 align-top text-[0.9rem] leading-snug text-ink/80">
                    {r.wins}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-6 max-w-[62ch] text-sm leading-snug text-board/75">
          &ldquo;Not advertised&rdquo; means exactly that: no public product or
          pricing page documents autonomous quoting. Some may ship it behind an
          add-on. Checked against vendors&rsquo; own pages and third-party buyer
          guides, November 2026.
        </p>
      </div>
    </section>
  );
}
