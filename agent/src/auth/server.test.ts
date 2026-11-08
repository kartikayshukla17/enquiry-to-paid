import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { createAuthServer } from "./server.js";

let db: TestDb;
let srv: Server;
let base: string;

beforeAll(async () => {
  db = await createTestDb();
  srv = createAuthServer(db.pool, {
    secret: "test-secret-test-secret-test-secret-1234",
    baseURL: "http://localhost:3000",
    google: { clientId: "cid.apps.googleusercontent.com", clientSecret: "x" },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(async () => {
  srv.close();
  await db.drop();
});

describe("auth HTTP server", () => {
  it("only serves /api/auth/*", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/etc`)).status).toBe(404);
  });

  it("POST sign-in/social returns the Google URL with our callback", async () => {
    const r = await fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ provider: "google", callbackURL: "/account" }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { url: string };
    const u = new URL(j.url);
    expect(u.origin).toBe("https://accounts.google.com");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/google");
  });

  it("email sign-up sets a session cookie that get-session accepts; sign-out clears it", async () => {
    const h = { "content-type": "application/json", origin: "http://localhost:3000" };
    const up = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ name: "Test", email: "t@example.test", password: "fictional-pass-123" }),
    });
    expect(up.status).toBe(200);
    const cookie = up.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("better-auth.session_token");
    const s = await fetch(`${base}/api/auth/get-session`, { headers: { cookie } });
    expect(((await s.json()) as { user: { email: string } }).user.email).toBe("t@example.test");
    const out = await fetch(`${base}/api/auth/sign-out`, { method: "POST", headers: { ...h, cookie }, body: "{}" });
    expect(out.status).toBe(200);
  });
});
