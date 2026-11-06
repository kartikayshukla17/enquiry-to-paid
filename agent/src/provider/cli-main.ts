import { LlmError } from "../llm/types.js";
import { checkEnable, enableProvider, type GateDeps } from "./gate.js";

const USAGE = "usage: pnpm provider enable <provider> <model> [--promote] | pnpm provider check <provider> <model>\n  exit 0: passes / enabled, 1: blocked, 2: usage or setup error\n";

/** `pnpm provider ...`. Exit 0 pass/enabled, 1 blocked by the gate, 2 usage or setup error. */
export async function providerMain(argv: string[], deps: GateDeps): Promise<{ code: number; out: string }> {
  const args = argv.filter((a) => a !== "--");
  const [cmd, provider, model, ...rest] = args;
  const flags = rest.filter((a) => a.startsWith("--"));
  const extra = rest.filter((a) => !a.startsWith("--"));
  if ((cmd !== "enable" && cmd !== "check") || !provider || !model || extra.length || flags.some((f) => f !== "--promote" || cmd !== "enable")) {
    return { code: 2, out: USAGE };
  }
  try {
    const r =
      cmd === "check"
        ? await checkEnable(provider, model, deps)
        : await enableProvider(provider, model, { ...deps, promote: flags.includes("--promote") });
    return { code: r.ok ? 0 : 1, out: r.out };
  } catch (e) {
    if (e instanceof LlmError) return { code: 2, out: `error: ${e.message}\n` };
    throw e;
  }
}
