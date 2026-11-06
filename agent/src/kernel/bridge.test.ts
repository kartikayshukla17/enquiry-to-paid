import { describe, expect, it } from "vitest";
import { loadKernel } from "./index.js";

describe("KernelBridge (public seam: evaluate JSON in / JSON out)", () => {
  it("calls Rust through WASM and returns a value", async () => {
    const kernel = await loadKernel();
    const out = kernel.evaluate({
      lines: [
        { unitMinor: 150000, qty: 3 },
        { unitMinor: 2500, qty: 2 },
      ],
    });
    expect(out).toEqual({ ok: true, totalMinor: 455000 });
  });

  it("returns typed errors from Rust instead of throwing", async () => {
    const kernel = await loadKernel();
    expect(kernel.evaluate({ lines: "nope" })).toEqual({
      ok: false,
      error: "invalid_input",
    });
  });

  it("is deterministic across repeated calls (no leaked state)", async () => {
    const kernel = await loadKernel();
    const input = { lines: [{ unitMinor: 7, qty: 9 }] };
    const first = JSON.stringify(kernel.evaluate(input));
    for (let i = 0; i < 100; i++) {
      expect(JSON.stringify(kernel.evaluate(input))).toBe(first);
    }
  });
});
