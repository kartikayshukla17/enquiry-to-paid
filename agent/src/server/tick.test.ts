import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { razorpaySim } from "../payments/razorpay-sim.js";
import { seedTenant } from "../payments/test-helpers.js";
import { seedOwnerMembers } from "../owner/seed.js";
import { runFixture } from "../simulator/run-fixture.js";
import { createAppServer } from "./app.js";

let db: TestDb;
let kernel: KernelBridge;

function startServer(opts: { tickSecret?: string }): Promise<{ srv: Server; base: string }> {
  const srv = createAppServer({
    pool: db.pool,
    kernel,
    providers: { "razorpay-sim": razorpaySim({ webhookSecret: "test-webhook-secret" }) },
    defaultProvider: "razorpay-sim",
    visitorIpKey: "test-visitor-ip-key",
    auth: { secret: "test-secret-test-secret-test-secret-1234", baseURL: "http://localhost:3000", google: { clientId: "cid.apps.googleusercontent.com", clientSecret: "x" } },
    ...(opts.tickSecret !== undefined && { tickSecret: opts.tickSecret }),
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` }));
  });
}

beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

describe("POST /tick: shared-secret auth", () => {
  it("401s when the server has no TICK_SECRET configured at all, even with a header", async () => {
    const { srv, base } = await startServer({});
    try {
      const r = await fetch(`${base}/tick`, { method: "POST", headers: { authorization: "Bearer anything" } });
      expect(r.status).toBe(401);
    } finally {
      srv.close();
    }
  });

  it("401s a request with no Authorization header at all", async () => {
    const { srv, base } = await startServer({ tickSecret: "tick-secret-fictional-1" });
    try {
      const r = await fetch(`${base}/tick`, { method: "POST" });
      expect(r.status).toBe(401);
    } finally {
      srv.close();
    }
  });

  it("401s a request with the wrong secret", async () => {
    const { srv, base } = await startServer({ tickSecret: "tick-secret-fictional-1" });
    try {
      const r = await fetch(`${base}/tick`, { method: "POST", headers: { authorization: "Bearer wrong-secret" } });
      expect(r.status).toBe(401);
    } finally {
      srv.close();
    }
  });

  it("200s a request carrying the correct secret as a Bearer token", async () => {
    const { srv, base } = await startServer({ tickSecret: "tick-secret-fictional-1" });
    try {
      const r = await fetch(`${base}/tick`, { method: "POST", headers: { authorization: "Bearer tick-secret-fictional-1" } });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ processed: 0, expiredHolds: 0, chasersSent: 0, digestsSent: 0 });
    } finally {
      srv.close();
    }
  });
});

describe("POST /tick: the demo -- a hold expires within one tick, and only on a tick", () => {
  it("does not expire a hold with no /tick call, then expires it and releases the date once /tick runs past expires_at", async () => {
    // fixtures/holds-saturday.json message 0: customer A quotes and holds Saturday 12 Dec 2026 for 48h from 7 Nov 2026 10:00 UTC.
    const before = await runFixture("fixtures/holds-saturday.json", { pool: db.pool, only: 0 });
    expect(before.turns[0]!.quote.kind).toBe("quote");
    const holdRow = async () => (await db.pool.query<{ status: string }>("SELECT status FROM holds WHERE tenant_id='tenant-rose-court'")).rows[0];
    expect((await holdRow())?.status).toBe("active");

    const { srv, base } = await startServer({ tickSecret: "tick-secret-fictional-2" });
    try {
      // No /tick call at all happened between placing the hold and here: still active (the "workflow disabled" half of the demo).
      expect((await holdRow())?.status).toBe("active");

      // The real clock decides `now` inside /tick, so prove expiry with a hold already past its expires_at:
      // the fixture places a 48h hold at 7 Nov 2026 10:00 UTC, which has already lapsed by any `now` this test runs at.
      const { rows } = await db.pool.query<{ expires_at: Date }>("SELECT expires_at FROM holds WHERE tenant_id='tenant-rose-court'");
      expect(rows[0]!.expires_at.getTime()).toBeLessThan(Date.now());

      const r = await fetch(`${base}/tick`, { method: "POST", headers: { authorization: "Bearer tick-secret-fictional-2" } });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.processed).toBeGreaterThanOrEqual(1);
      expect(body.expiredHolds).toBeGreaterThanOrEqual(1);
      expect((await holdRow())?.status).toBe("expired");
    } finally {
      srv.close();
    }
  });
});

describe("POST /tick: the owner digest due-check", () => {
  const T = { id: "tenant-digest-fictional", name: "FICTIONAL: Digest Co" };
  const digestEntries = (tenantId: string) => db.pool.query("SELECT payload FROM ledger_entries WHERE tenant_id=$1 AND type='owner_message'", [tenantId]);

  it("sends exactly one digest to a due tenant with push recipients, writes one ledger entry, then does not resend inside 24h", async () => {
    await seedTenant(db.pool, kernel, T);
    await seedOwnerMembers(db.pool, T.id, [{ role: "owner", phone: "+91 00000 50001" }]);
    const { srv, base } = await startServer({ tickSecret: "tick-secret-fictional-3" });
    try {
      const tick = () => fetch(`${base}/tick`, { method: "POST", headers: { authorization: "Bearer tick-secret-fictional-3" } });

      const r1 = await tick();
      const b1 = await r1.json();
      expect(b1.digestsSent).toBe(1);
      const after1 = await digestEntries(T.id);
      expect(after1.rows).toHaveLength(1);
      expect(after1.rows[0]!.payload).toMatchObject({ command: "digest_sent" });

      // Running /tick again right away must not send (or ledger) a second digest for the same tenant.
      const r2 = await tick();
      const b2 = await r2.json();
      expect(b2.digestsSent).toBe(0);
      expect((await digestEntries(T.id)).rows).toHaveLength(1);
    } finally {
      srv.close();
    }
  });

  it("skips a tenant that exists but has nobody to push to: no digest sent, no ledger entry written", async () => {
    const quiet = { id: "tenant-digest-quiet", name: "FICTIONAL: Quiet Co" };
    await seedTenant(db.pool, kernel, quiet); // no seedOwnerMembers: legacy approval owner has no phone_hash, so zero push recipients
    const { srv, base } = await startServer({ tickSecret: "tick-secret-fictional-4" });
    try {
      const r = await fetch(`${base}/tick`, { method: "POST", headers: { authorization: "Bearer tick-secret-fictional-4" } });
      await r.json();
      expect((await digestEntries(quiet.id)).rows).toHaveLength(0);
    } finally {
      srv.close();
    }
  });
});
