import type { Metadata } from "next";
import { Anton, Yatra_One, Mukta, Cairo } from "next/font/google";
import { PaletteSwitcher } from "@/components/site/palette-switcher";
import "./globals.css";

/** Applies the visitor's saved board colour before first paint, so the
 *  page never flashes cobalt on its way to another ground. */
const PALETTE_BOOT = `(function(){try{var p=localStorage.getItem("board-colour");if(p&&["cobalt","bottle","sindoor","ink","peacock","aubergine"].indexOf(p)>-1){document.documentElement.dataset.palette=p}}catch(e){}})();`;

const anton = Anton({
  variable: "--font-anton",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

const yatra = Yatra_One({
  variable: "--font-yatra",
  subsets: ["devanagari", "latin"],
  weight: "400",
  display: "swap",
});

const mukta = Mukta({
  variable: "--font-mukta",
  subsets: ["devanagari", "latin"],
  weight: ["400", "600", "700", "800"],
  display: "swap",
});

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Enquiry to Paid",
  description:
    "One WhatsApp number that answers every enquiry, sends a real price the same hour, chases the quote and collects the money.",
};

const CONTRACT = `<!--
THESIS: A quoting agent sold the way its buyer's own street sells — a painted
board that states one price and one instruction. Refuses the dark-SaaS glow page.
OWN-WORLD: Enamel on tin. Cobalt ground 60%, cream board 30%, cadmium gold and
vermilion signal 10%. Anton caps with ink shadow and cream highlight; Yatra One
Devanagari; Mukta body. Sodium-vapour light pools from above; gloss bands on panels.
STORY: An owner-operator sees the money a missed message costs, watches a price
get painted on without a human, learns it refuses to guess, and sends their rate card.
FIRST VIEWPORT: Full-bleed cobalt hoarding. Painted caps left at hoarding scale with
the Hindi line beneath; the rate board right, where an enquiry becomes Rs 3,80,000
painted on with a brush stroke under it. Primary action on the board's bottom edge.
FORM: The Sign Painter's Board, candidate 1 of my grounded list (Impeccable's Pick,
chosen over the roll's assignment). Seed key e9a09983.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${anton.variable} ${yatra.variable} ${mukta.variable} ${cairo.variable} antialiased`}
      >
        <script dangerouslySetInnerHTML={{ __html: PALETTE_BOOT }} />
        <div hidden dangerouslySetInnerHTML={{ __html: CONTRACT }} />
        <div className="sodium" aria-hidden="true" />
        <div className="relative z-10">{children}</div>
        <PaletteSwitcher />
      </body>
    </html>
  );
}
