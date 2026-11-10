import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { razorpaySim } from "../payments/razorpay-sim.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { createAppServer } from "./app.js";

// V3a proof: the onboarding UI talks to the real HTTP endpoints (sign-up, then organization/create)
// over cookies, not to auth.api directly. These tests exercise that exact wire path, as opposed to
// auth.test.ts's server-side auth.api.* calls, to prove the sign-up-flow seam specifically.

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
    auth: { secret: "test-secret-test-secret-test-secret-1234", baseURL: "http://localhost:3000" },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(async () => {
  srv.close();
  await db.drop();
});

/** Signs up a fresh fictional user over real HTTP and returns their session cookie, the way the browser would. */
async function signUpAndGetCookie(label: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: label, email: `${label}@example.test`, password: "fictional-pass-123" }),
  });
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

/** Same shape the onboarding form posts: a business name plus the slug it derives client-side. */
async function createOrg(cookie: string, name: string, slug: string) {
  const r = await fetch(`${base}/api/auth/organization/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name, slug }),
  });
  expect(r.status).toBe(200);
  return r.json();
}

describe("the real sign-up -> create-business organization wire path", () => {
  it("POST /api/auth/organization/create (the onboarding form's endpoint) mirrors a new tenant", async () => {
    const cookie = await signUpAndGetCookie("onboarding-owner-one");
    const org = await createOrg(cookie, "FICTIONAL: Rose Court Banquets", "rose-court-banquets-aa11bb");
    const tenantRow = await db.pool.query("SELECT id, name FROM tenants WHERE id=$1", [org.id]);
    expect(tenantRow.rows).toEqual([{ id: org.id, name: "FICTIONAL: Rose Court Banquets" }]);
  });

  it("two fictional accounts, each creating a business through the sign-up endpoint, land in two separate, mutually invisible tenants", async () => {
    const cookieA = await signUpAndGetCookie("onboarding-owner-two");
    const cookieB = await signUpAndGetCookie("onboarding-owner-three");
    const orgA = await createOrg(cookieA, "FICTIONAL: Lotus Caterers", "lotus-caterers-cc22dd");
    const orgB = await createOrg(cookieB, "FICTIONAL: Marigold Decor", "marigold-decor-ee33ff");
    expect(orgA.id).not.toBe(orgB.id);

    const seenFromA = await withTenant(db.pool, orgA.id, (c) => c.query("SELECT user_id FROM members"));
    const seenFromB = await withTenant(db.pool, orgB.id, (c) => c.query("SELECT user_id FROM members"));
    expect(seenFromA.rows).toHaveLength(1);
    expect(seenFromB.rows).toHaveLength(1);
    expect(seenFromA.rows[0]!.user_id).not.toBe(seenFromB.rows[0]!.user_id);
  });

  it("GET /api/auth/get-session (what the session gate checks) is null before sign-in and populated after", async () => {
    const anon = await fetch(`${base}/api/auth/get-session`);
    expect(anon.status).toBe(200);
    expect(await anon.json()).toBeNull();

    const cookie = await signUpAndGetCookie("onboarding-owner-four");
    const signedIn = await fetch(`${base}/api/auth/get-session`, { headers: { cookie } });
    const body = await signedIn.json();
    expect(body.user.email).toBe("onboarding-owner-four@example.test");
  });
});
