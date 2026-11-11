/** Stripe-specific behaviour (header scheme, replay window on the injected clock). Observed through handleWebhook only. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { handleWebhook } from "./webhook.js";
import { STRIPE_TEST_SECRET, stripeAsyncPaymentSucceeded, stripePaid, stripeSign } from "./provider-kit.js";
import { stripePaymentLinksSim } from "./stripe-sim.js";
import { ask, NOW, seedTenant } from "./test-helpers.js";

let db: TestDb;
let kernel: KernelBridge;
beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
});
afterAll(async () => {
  await db.drop();
});

const T = { id: "tenant-stripe-only", name: "FICTIONAL: Stripe Only Events" };
const provider = stripePaymentLinksSim({ webhookSecret: STRIPE_TEST_SECRET });
const deps = () => ({ pool: db.pool, kernel, payments: provider });
const at = (offsetSec: number) => new Date(Date.parse(NOW) + offsetSec * 1000).toISOString();
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

async function quoted(threadId: string) {
  const card = await seedTenant(db.pool, kernel, T);
  const res = await ask(db.pool, kernel, provider, T, card, threadId);
  if (res.outcome.kind !== "quote") throw new Error("expected quote");
  const row = await withTenant(db.pool, T.id, (c) => c.query("SELECT provider_link_id FROM payments WHERE thread_id=$1", [threadId]));
  return { total: res.outcome.total, linkId: row.rows[0].provider_link_id as string };
}
const collectedCount = (threadId: string) => withTenant(db.pool, T.id, async (c) => (await c.query("SELECT 1 FROM ledger_entries WHERE thread_id=$1 AND type='collected'", [threadId])).rowCount);

describe("Stripe-Signature: timestamp tolerance is enforced against the injected clock", () => {
  it("a delivery signed 10 minutes before the receiver's clock is a replay: rejected, nothing written, nothing recorded", async () => {
    const q = await quoted("st-old");
    const ev = stripePaid({ linkId: q.linkId, tenantId: T.id, amount: q.total, now: at(-600) });
    expect(await handleWebhook(deps(), ev.body, ev.headers, NOW)).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(await collectedCount("st-old")).toBe(0);
    expect((await withTenant(db.pool, T.id, (c) => c.query("SELECT 1 FROM payment_events"))).rowCount).toBe(0);
  });

  it("the same signed delivery is accepted when the injected clock is inside the window, and rejected again once it moves past it", async () => {
    const q = await quoted("st-win");
    const ev = stripePaid({ linkId: q.linkId, tenantId: T.id, amount: q.total, now: NOW });
    expect((await handleWebhook(deps(), ev.body, ev.headers, at(301)).then((r) => r.status))).toBe("rejected");
    expect((await handleWebhook(deps(), ev.body, ev.headers, at(-301))).status).toBe("rejected");
    expect((await handleWebhook(deps(), ev.body, ev.headers, at(300))).status).toBe("collected");
    expect(await handleWebhook(deps(), ev.body, ev.headers, at(400))).toEqual({ status: "rejected", reason: "bad_signature" });
  });

  it("a timestamp from the future beyond tolerance is rejected too", async () => {
    const q = await quoted("st-fut");
    const ev = stripePaid({ linkId: q.linkId, tenantId: T.id, amount: q.total, now: at(900) });
    expect((await handleWebhook(deps(), ev.body, ev.headers, NOW)).status).toBe("rejected");
  });

  it("rewriting t to look fresh invalidates the signature (t is part of the signed payload)", async () => {
    const q = await quoted("st-t");
    const old = stripePaid({ linkId: q.linkId, tenantId: T.id, amount: q.total, now: at(-3600) });
    const v1 = /v1=([0-9a-f]+)/.exec(old.headers["stripe-signature"])![1];
    const forged = { "stripe-signature": `t=${sec(NOW)},v1=${v1}` };
    expect((await handleWebhook(deps(), old.body, forged, NOW)).status).toBe("rejected");
    expect(await collectedCount("st-t")).toBe(0);
  });

  it("malformed headers are rejected: no t, no v1, junk, duplicate t, non-numeric t", async () => {
    const q = await quoted("st-mal");
    const ev = stripePaid({ linkId: q.linkId, tenantId: T.id, amount: q.total });
    const t = sec(NOW);
    const v1 = /v1=([0-9a-f]+)/.exec(ev.headers["stripe-signature"])![1];
    for (const h of [`v1=${v1}`, `t=${t}`, "garbage", `t=${t},t=${t},v1=${v1}`, `t=abc,v1=${v1}`, `t=${t},v0=${v1}`, ""]) {
      expect((await handleWebhook(deps(), ev.body, { "stripe-signature": h }, NOW)).status, h).toBe("rejected");
    }
    expect(await collectedCount("st-mal")).toBe(0);
  });

  it("several v1 signatures (secret rotation): accepted if any one matches", async () => {
    const q = await quoted("st-rot");
    const ev = stripePaid({ linkId: q.linkId, tenantId: T.id, amount: q.total });
    const t = sec(NOW);
    const stale = stripeSign(ev.body, t, "whsec_rotated_out").split(",")[1];
    const good = ev.headers["stripe-signature"].split(",")[1];
    expect((await handleWebhook(deps(), ev.body, { "stripe-signature": `t=${t},${stale},${good}` }, NOW)).status).toBe("collected");
  });
});

describe("Stripe idempotency keys on the signed body, not on timestamps or headers", () => {
  it("the same body re-signed with a fresh timestamp (a legitimate Stripe retry) is a duplicate", async () => {
    const q = await quoted("st-retry");
    const first = stripePaid({ linkId: q.linkId, tenantId: T.id, amount: q.total, eventId: "evt_retry", now: NOW });
    expect((await handleWebhook(deps(), first.body, first.headers, NOW)).status).toBe("collected");
    const again = { body: first.body, headers: { "stripe-signature": stripeSign(first.body, sec(NOW) + 120) } };
    expect(await handleWebhook(deps(), again.body, again.headers, at(120))).toEqual({ status: "duplicate" });
    expect(await collectedCount("st-retry")).toBe(1);
  });

  it("checkout.session.async_payment_succeeded (a delayed payment method clearing later) collects exactly like checkout.session.completed", async () => {
    const q = await quoted("st-async-ok");
    const ev = stripeAsyncPaymentSucceeded({ linkId: q.linkId, tenantId: T.id, amount: q.total });
    expect((await handleWebhook(deps(), ev.body, ev.headers, NOW)).status).toBe("collected");
    expect(await collectedCount("st-async-ok")).toBe(1);
  });

  it("only checkout.session.completed or checkout.session.async_payment_succeeded with payment_status paid collects; other events are ignored", async () => {
    const q = await quoted("st-other");
    const mk = (type: string, status: string) => {
      const base = JSON.parse(stripePaid({ linkId: q.linkId, tenantId: T.id, amount: q.total }).body);
      base.type = type;
      base.data.object.payment_status = status;
      const body = JSON.stringify(base);
      return { body, headers: { "stripe-signature": stripeSign(body, sec(NOW)) } };
    };
    for (const e of [mk("charge.refunded", "paid"), mk("checkout.session.completed", "unpaid")]) {
      expect(await handleWebhook(deps(), e.body, e.headers, NOW)).toEqual({ status: "ignored", reason: "not_a_payment_event" });
    }
    expect(await collectedCount("st-other")).toBe(0);
  });
});
