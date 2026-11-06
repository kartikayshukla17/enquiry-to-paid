import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadKernel } from "./index.js";

const card = JSON.parse(
  readFileSync(new URL("../../../rate-cards/fictional-banquet.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const input = (fields: Record<string, unknown>) => ({
  rateCard: card,
  fields,
  availability: { blockedDates: [] },
  now: "2026-11-07T10:00:00Z",
});
const saturday = { service: "banquet", date: "2026-12-12", guestCount: 120, language: "en", confidenceBps: 9200 };

describe("KernelBridge (public seam: evaluate JSON in / JSON out)", () => {
  it("prices through Rust/WASM and returns a quote", async () => {
    const kernel = await loadKernel();
    const out = kernel.evaluate(input(saturday)) as { kind: string; total: number };
    expect(out.kind).toBe("quote");
    expect(out.total).toBe(56_640_000);
  });

  it("returns typed errors from Rust instead of throwing", async () => {
    const kernel = await loadKernel();
    expect(kernel.evaluate({ lines: "nope" })).toEqual({ ok: false, error: "invalid_input" });
  });

  it("returns a typed refusal when no rule covers the enquiry", async () => {
    const kernel = await loadKernel();
    expect(kernel.evaluate(input({ ...saturday, guestCount: 900 }))).toEqual({
      kind: "refusal",
      reason: "no_covering_rule",
      ruleGap: "guestCount",
    });
  });

  it("is byte-identical across 100 calls (no leaked state)", async () => {
    const kernel = await loadKernel();
    const first = JSON.stringify(kernel.evaluate(input(saturday)));
    for (let i = 0; i < 100; i++) {
      expect(JSON.stringify(kernel.evaluate(input(saturday)))).toBe(first);
    }
  });

  it("exports the rate card hash and the quote pins it", async () => {
    const kernel = await loadKernel();
    const hash = kernel.rateCardHash(card);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect((kernel.evaluate(input(saturday)) as { rateCardHash: string }).rateCardHash).toBe(hash);
  });
});
