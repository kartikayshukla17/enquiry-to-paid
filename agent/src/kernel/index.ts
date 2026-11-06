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
  rate_card_hash_json(ptr: number, len: number): number;
  chain_hash_json(ptr: number, len: number): number;
  verify_chain_json(ptr: number, len: number): number;
  result_len(): number;
}

export type ChainVerdict =
  | { ok: true; count: number }
  | { ok: false; brokenSeq: number | null; reason: "seq_gap" | "prev_hash_mismatch" | "hash_mismatch" };

export interface KernelBridge {
  /** JSON in, JSON out. Errors from the kernel are returned as typed values. */
  evaluate(input: unknown): unknown;
  /** SHA-256 hex of the canonical card JSON, computed in Rust. */
  rateCardHash(card: unknown): string;
  /** Ledger chain hash of one entry's content fields (incl. prevHash), computed in Rust. */
  chainHash(entry: unknown): string;
  /** Verifies ONE tenant's ordered entries; reports the first broken row. */
  verifyChain(entries: unknown[]): ChainVerdict;
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

  const call = (fn: (ptr: number, len: number) => number, json: string): string => {
    const input = new TextEncoder().encode(json);
    const inPtr = k.alloc(input.length);
    new Uint8Array(k.memory.buffer, inPtr, input.length).set(input);
    const outPtr = fn(inPtr, input.length);
    const outLen = k.result_len();
    const out = new TextDecoder().decode(
      new Uint8Array(k.memory.buffer, outPtr, outLen).slice(),
    );
    k.dealloc(inPtr, input.length);
    k.dealloc(outPtr, outLen);
    return out;
  };

  return {
    evaluate: (input) =>
      JSON.parse(call((p, l) => k.evaluate_json(p, l), JSON.stringify(input))) as unknown,
    rateCardHash: (card) => call((p, l) => k.rate_card_hash_json(p, l), JSON.stringify(card)),
    chainHash: (entry) => call((p, l) => k.chain_hash_json(p, l), JSON.stringify(entry)),
    verifyChain: (entries) =>
      JSON.parse(call((p, l) => k.verify_chain_json(p, l), JSON.stringify(entries))) as ChainVerdict,
  };
}
