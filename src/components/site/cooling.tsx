"use client";

const ENQUIRIES = [
  { at: "9:41 pm", text: "18 Dec, 250 log, veg only. Budget?", fate: "answered 11:10 am" },
  { at: "10:06 pm", text: "Sangeet ke liye hall free hai 4 Jan?", fate: "answered next evening" },
  { at: "11:22 pm", text: "Pre-wedding shoot rate kya hai?", fate: "never answered" },
  { at: "1:14 am", text: "Catering only, 90 pax, 2 Feb?", fate: "never answered" },
];

export function Cooling() {
  return (
    <section className="relative px-[max(1.25rem,env(safe-area-inset-left))] py-20 sm:py-24">
      <div className="mx-auto max-w-[78rem]">
        <h2 className="painted font-display max-w-[24ch] text-[clamp(1.95rem,5.2vw,3.5rem)] leading-[0.95] uppercase tracking-[-0.02em] [text-wrap:balance]">
          Your busiest hours are the ones nobody answers.
        </h2>

        <p className="mt-6 max-w-[54ch] text-board/85 sm:text-lg">
          Enquiries do not arrive during working hours. They arrive while you
          are running a function, and they go cold while you sleep. A cold
          enquiry does not wait — it books the hall down the road.
        </p>

        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ENQUIRIES.map((e, i) => (
            <li
              key={e.at}
              className="panel-dark flex flex-col gap-3 border-l-0 p-5"
            >
              <p
                className="nums font-display cooling text-xl tracking-[0.02em]"
                style={{ animationDelay: `${i * 0.5}s` }}
              >
                {e.at}
              </p>
              <p className="text-[0.95rem] leading-snug text-board/85">
                {e.text}
              </p>
              <p className="mt-auto pt-3 text-xs uppercase tracking-[0.08em] text-signal">
                {e.fate}
              </p>
            </li>
          ))}
        </ul>

        <p className="mt-10 max-w-[52ch] text-sm text-board/75">
          Example times and messages, written to show the shape of the problem.
          Count your own from last week — that number is what this is for.
        </p>
      </div>
    </section>
  );
}
