// Placeholder offline eval (T7 builds the real harness): runs every fixture through
// the kernel and reply renderer with no network and no database, then prints OK.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadKernel } from "../kernel/index.js";
import type { Outcome } from "../kernel/types.js";
import { renderReply } from "../pipeline/reply.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = `${root}agent/fixtures/`;
const kernel = await loadKernel();
let n = 0;
for (const f of (await readdir(dir)).filter((x) => x.endsWith(".json")).sort()) {
  const fx = JSON.parse(await readFile(`${dir}${f}`, "utf8"));
  const rateCard = JSON.parse(await readFile(`${root}${fx.rateCard}`, "utf8"));
  const out = kernel.evaluate({ rateCard, fields: fx.extracted, availability: fx.availability, now: fx.now }) as Outcome;
  if (!("kind" in out)) throw new Error(`${f}: kernel error ${JSON.stringify(out)}`);
  if (renderReply(out, fx.extracted).length === 0) throw new Error(`${f}: empty reply`);
  console.log(`  ${f}: ${out.kind}`);
  n++;
}
console.log(`eval (placeholder, fictional data): ${n} fixture(s) OK`);
