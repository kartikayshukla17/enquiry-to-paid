# Kernel bridge decision (T0)

**Chosen: WebAssembly** (`wasm32-unknown-unknown`), hand-written `extern "C"` ABI, loaded with Node's built-in `WebAssembly` API.

## How it works
- `kernel/src/lib.rs` has a pure `evaluate(&str) -> String` (JSON in, JSON out, integer minor units, typed `{ok:false,error}` instead of panics).
- Exports: `alloc(len)`, `dealloc(ptr,len)`, `evaluate_json(ptr,len) -> ptr`, `result_len()`. The host writes UTF-8 JSON into `alloc`ed memory and reads the result buffer back, then frees both.
- `pnpm build:kernel` runs `cargo build --release --target wasm32-unknown-unknown` and copies the result to `kernel/dist/kernel.wasm` (git-ignored). `agent/src/kernel/index.ts` (`loadKernel()`) is the `KernelBridge`.
- Tests: `cargo test` (Rust public seam `evaluate`) and vitest through the bridge. `pnpm test` runs both.

## Why
- No native addon: no per-platform binaries, no node-gyp/napi toolchain, no ABI breakage across Node versions; the same `.wasm` runs on a Mac, in CI and on a Linux server.
- Sandboxed and deterministic: no I/O or clock reachable from the kernel, which fits "the kernel never reads free text and is pure".
- No wasm-bindgen CLI needed; the (ptr,len) JSON protocol is about 60 lines per side.

## Alternatives
- napi-rs: faster calls and richer types, but native builds per OS/arch and CI matrix; unnecessary for a pricing call measured in microseconds.
- wasm-bindgen: nicer glue, but an extra CLI/version pin to manage.
- TS kernel behind the same interface: the fallback; not needed.

## Timebox result
Succeeded well inside the timebox (target install, build, Rust tests, Node bridge test all green). No fallback needed. Cost: JSON serialisation on each call and manual buffer management, both confined to `agent/src/kernel/index.ts`.
