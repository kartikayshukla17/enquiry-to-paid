import { mkdirSync, copyFileSync } from "node:fs";

mkdirSync("kernel/dist", { recursive: true });
copyFileSync(
  "kernel/target/wasm32-unknown-unknown/release/kernel.wasm",
  "kernel/dist/kernel.wasm",
);
console.log("kernel/dist/kernel.wasm updated");
