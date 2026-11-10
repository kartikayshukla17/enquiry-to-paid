import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { razorpaySim } from "../payments/razorpay-sim.js";
import { createAppServer } from "./app.js";

let db: TestDb;
let kernel: KernelBridge;
let srv: Server;
let base: string;

beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
  srv = createAppServer({
    pool: db.pool,
    kernel,
    providers: { "razorpay-sim": razorpaySim({ webhookSecret: "test-webhook-secret" }) },
    defaultProvider: "razorpay-sim",
    visitorIpKey: "test-visitor-ip-key",
    auth: { secret: "test-secret-test-secret-test-secret-1234", baseURL: "http://localhost:3000", google: { clientId: "cid.apps.googleusercontent.com", clientSecret: "x" } },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(async () => {
  srv.close();
  await db.drop();
});

async function post(path: string, body: unknown) {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

describe("the merged agent server (auth + simulator + payments in one process)", () => {
  it("serves /health", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it("serves Better Auth under /api/auth/*, including Google sign-in", async () => {
    const r = await fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    });
    expect(r.status).toBe(200);
    const u = new URL((await r.json()).url);
    expect(u.origin).toBe("https://accounts.google.com");
  });

  it("runs a chat enquiry through the real pipeline and returns a ledger row", async () => {
    const { status, body } = await post("/chat", { text: "Hi, wedding reception for 150 guests, Saturday 12 December 2026", customerRef: "app-test-1", card: "rate-cards/fictional-banquet.json" });
    expect(status).toBe(200);
    expect(body.ledgerRow.payload.kind).toBe("quote");
  });

  it("rejects an oversized or empty chat message before touching the pipeline", async () => {
    expect((await post("/chat", { text: "" })).status).toBe(400);
  });

  it("accepts playground feedback and rejects an unknown card", async () => {
    expect((await post("/feedback", { card: "rate-cards/fictional-banquet.json", rating: "up" })).status).toBe(200);
    expect((await post("/feedback", { card: "nope", rating: "up" })).status).toBe(400);
  });

  it("answers a payment-status lookup for a thread with no payment yet", async () => {
    const r = await fetch(`${base}/payment-status?customerRef=app-test-none&card=${encodeURIComponent("rate-cards/fictional-banquet.json")}`);
    expect(r.status).toBe(200);
    expect((await r.json()).payment).toBeNull();
  });

  it("rejects an unsigned payment webhook and an unknown provider", async () => {
    expect((await post("/webhooks/payments/razorpay-sim", {})).status).toBe(401);
    expect((await post("/webhooks/payments/not-a-provider", {})).status).toBe(404);
  });

  it("404s anything else", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
