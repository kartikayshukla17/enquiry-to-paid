import { readFile } from "node:fs/promises";
import path from "node:path";
import type { KernelBridge } from "../kernel/index.js";
import { compileTemplate, formatCompileError, readTemplateDir } from "./compile.js";
import { REPO_ROOT } from "./paths.js";

/**
 * A card source relative to the repo root: either a hand-written `*.json` card or a template directory of CSV sheets
 * (compiled on the spot; a broken cell throws with the exact-cell messages).
 */
export async function loadCardSource(source: string, kernel: KernelBridge): Promise<unknown> {
  const abs = path.isAbsolute(source) ? source : path.join(REPO_ROOT, source);
  if (abs.endsWith(".json")) return JSON.parse(await readFile(abs, "utf8")) as unknown;
  const res = compileTemplate(await readTemplateDir(abs), kernel);
  if (!res.ok) throw new Error(`template ${source} does not compile:\n${res.errors.map(formatCompileError).join("\n")}`);
  return res.card;
}
