import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Default artifact: kernel/dist/kernel.wasm (built by `pnpm build:kernel`). */
const DEFAULT_WASM = fileURLToPath(
  new URL("../../../kernel/dist/kernel.wasm", import.meta.url),
);

interface KernelExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  evaluate_json(ptr: number, len: number): number;
  result_len(): number;
}

export interface KernelBridge {
  /** JSON in, JSON out. Errors from the kernel are returned as typed values. */
  evaluate(input: unknown): unknown;
}

export async function loadKernel(wasmPath: string = DEFAULT_WASM): Promise<KernelBridge> {
  let bytes: Buffer;
  try {
    bytes = await readFile(wasmPath);
  } catch {
    throw new Error(`kernel wasm not found at ${wasmPath}; run \`pnpm build:kernel\``);
  }
  const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)), {});
  const k = instance.exports as unknown as KernelExports;

  const call = (json: string): string => {
    const input = new TextEncoder().encode(json);
    const inPtr = k.alloc(input.length);
    new Uint8Array(k.memory.buffer, inPtr, input.length).set(input);
    const outPtr = k.evaluate_json(inPtr, input.length);
    const outLen = k.result_len();
    const out = new TextDecoder().decode(
      new Uint8Array(k.memory.buffer, outPtr, outLen).slice(),
    );
    k.dealloc(inPtr, input.length);
    k.dealloc(outPtr, outLen);
    return out;
  };

  return { evaluate: (input) => JSON.parse(call(JSON.stringify(input))) as unknown };
}
