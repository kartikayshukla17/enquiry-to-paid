import { Marquee } from "@/components/ui/marquee";
import { Star } from "@/components/site/icons";

const TRADES = [
  "Banquet halls",
  "Cafés",
  "Photo studios",
  "Salons",
  "Contractors",
  "Builders' sales desks",
  "Caterers",
  "Event decorators",
];

export function Strip() {
  return (
    <div className="relative border-y-[3px] border-ink bg-gold py-3.5">
      <Marquee pauseOnHover className="[--duration:34s] [--gap:0rem]">
        {TRADES.map((t) => (
          <span
            key={t}
            className="font-display flex items-center gap-7 px-7 text-lg uppercase tracking-[0.06em] text-ink sm:text-xl"
          >
            {t}
            <Star className="h-3.5 w-3.5 shrink-0 text-signal" />
          </span>
        ))}
      </Marquee>
    </div>
  );
}
