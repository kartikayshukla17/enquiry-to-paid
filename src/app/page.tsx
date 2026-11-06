import { Hero } from "@/components/site/hero";
import { Strip } from "@/components/site/strip";
import { Cooling } from "@/components/site/cooling";
import { Pipeline } from "@/components/site/pipeline";
import { Refusal } from "@/components/site/refusal";
import { Compare } from "@/components/site/compare";
import { Pricing } from "@/components/site/pricing";
import { Status } from "@/components/site/status";
import { Cta, Footer } from "@/components/site/cta";

export default function Home() {
  return (
    <main>
      <Hero />
      <Strip />
      <Cooling />
      <Pipeline />
      <Refusal />
      <Compare />
      <Pricing />
      <Status />
      <Cta />
      <Footer />
    </main>
  );
}
