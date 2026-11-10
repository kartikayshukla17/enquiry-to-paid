import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { DEFAULT_DATABASE_URL } from "../ledger/test-db.js";
import { migrate } from "../ledger/migrate.js";
import { runChat } from "./chat.js";
import { REPO_ROOT } from "../ratecard/paths.js";
import { loadKernel } from "../kernel/index.js";
import { webhookHttpStatus } from "../payments/http.js";
import { razorpayLive } from "../payments/razorpay-live.js";
import { razorpaySim, razorpaySecretFromEnv } from "../payments/razorpay-sim.js";
import type { ProviderRegistry } from "../payments/registry.js";
import { stripeLive } from "../payments/stripe-live.js";
import { stripePaymentLinksSim, stripeSecretFromEnv } from "../payments/stripe-sim.js";
import { handleProviderWebhook } from "../payments/webhook.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { checkAndBumpUsage, hashVisitorIp, recordFeedback } from "./playground.js";

/**
 * Local-only HTTP seam for the web simulator page: POST /chat {text, customerRef?, tenantId?, card?} -> {reply, ledgerRow, held?}.
 * Same pipeline as `pnpm sim chat`; nothing here prices or words anything. Binds to 127.0.0.1 only.
 */
const PORT = Number(process.env.SIM_WEB_PORT ?? 4010);
const MAX_BODY = 8 * 1024;
const MAX_WEBHOOK_BODY = 256 * 1024;
// Allowlist = the fictional cards on disk (read from the directory, so no vertical is named here).
const CARDS = new Set(
  readdirSync(`${REPO_ROOT}rate-cards`)
    .filter((f) => /^fictional-.*\.json$/.test(f))
    .map((f) => `rate-cards/${f}`),
);

// Demo convenience only (same as `pnpm sim`): throwaway process-local keys when none are configured.
for (const name of ["PII_ENC_KEY", "PHONE_HASH_KEY"]) {
  if (!process.env[name]) process.env[name] = randomBytes(32).toString("base64");
}
// Reused as the playground's visitor-IP HMAC key: already a server-only secret, no new env var needed.
const VISITOR_IP_KEY = process.env.PHONE_HASH_KEY!;

function visitorIp(req: import("node:http").IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
await migrate(pool);

// Providers: simulators always; the real adapters only when their credentials are present (test keys in development).
const providers: ProviderRegistry = {
  "razorpay-sim": razorpaySim({ webhookSecret: razorpaySecretFromEnv() }),
  "stripe-sim": stripePaymentLinksSim({ webhookSecret: stripeSecretFromEnv() }),
};
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET) {
  providers.razorpay = razorpayLive({ keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET, webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET });
}
if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
  providers.stripe = stripeLive({ secretKey: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET });
}
const DEFAULT_PROVIDER = process.env.PAYMENTS_PROVIDER && providers[process.env.PAYMENTS_PROVIDER] ? process.env.PAYMENTS_PROVIDER : providers.razorpay ? "razorpay" : "razorpay-sim";
const kernel = await loadKernel();
const tenantFor = (card?: string) => (card ? `tenant-web-${card.split("fictional-")[1]!.replace(".json", "")}` : "tenant-rose-court");

function readBody(req: import("node:http").IncomingMessage, max = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, provider: process.env.LLM_PROVIDER ?? "fixture", mode: process.env.LLM_MODE ?? "replay" });
    const hook = req.method === "POST" ? /^\/webhooks\/payments\/([a-z-]{3,20})$/.exec(req.url ?? "") : null;
    if (hook) {
      const raw = await readBody(req, MAX_WEBHOOK_BODY);
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
      const r = await handleProviderWebhook({ pool, kernel, providers }, hook[1]!, raw, headers, new Date().toISOString());
      console.error(`[webhook] ${hook[1]} -> ${r.status}${"reason" in r ? ` (${r.reason})` : ""}`);
      return send(webhookHttpStatus(r), { status: r.status });
    }
    if (req.method === "GET" && req.url?.startsWith("/payment-status")) {
      const q = new URL(req.url, "http://x").searchParams;
      const card = q.get("card") ?? undefined;
      const ref = q.get("customerRef") ?? "";
      if (!/^[a-z0-9-]{4,40}$/.test(ref) || (card && !CARDS.has(card))) return send(400, { error: "bad request" });
      const tenantId = tenantFor(card);
      const row = await withTenant(pool, tenantId, async (c) =>
        (await c.query("SELECT provider, status, amount_minor::text AS amount_minor, currency, link_url FROM payments WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 1", [`${tenantId}:thread:chat:${ref}`])).rows[0],
      );
      return send(200, { payment: row ?? null });
    }
    if (req.method === "POST" && req.url === "/feedback") {
      const f = JSON.parse(await readBody(req)) as { card?: unknown; rating?: unknown; comment?: unknown };
      if (typeof f.card !== "string" || !CARDS.has(f.card)) return send(400, { error: "unknown card" });
      if (f.rating !== "up" && f.rating !== "down") return send(400, { error: "rating must be 'up' or 'down'" });
      if (f.comment !== undefined && (typeof f.comment !== "string" || f.comment.length > 1000)) return send(400, { error: "comment must be at most 1000 characters" });
      await recordFeedback(pool, { card: f.card, rating: f.rating, now: new Date().toISOString(), ...(typeof f.comment === "string" && f.comment.trim() && { comment: f.comment.trim() }) });
      return send(200, { ok: true });
    }
    if (req.method !== "POST" || req.url !== "/chat") return send(404, { error: "not found" });
    const ipHash = hashVisitorIp(visitorIp(req), VISITOR_IP_KEY);
    const usage = await checkAndBumpUsage(pool, ipHash, new Date().toISOString().slice(0, 10));
    if (!usage.ok) return send(429, { error: "Daily playground limit reached. Please come back tomorrow." });
    const b = JSON.parse(await readBody(req)) as { text?: unknown; customerRef?: unknown; tenantId?: unknown; card?: unknown };
    if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 1000) return send(400, { error: "text must be 1-1000 characters" });
    const customerRef = typeof b.customerRef === "string" && /^[a-z0-9-]{4,40}$/.test(b.customerRef) ? b.customerRef : "web-sim-customer";
    const card = typeof b.card === "string" && CARDS.has(b.card) ? b.card : undefined;
    // Each card gets its own tenant so threads and approvals never mix across verticals.
    const tenantId = tenantFor(card);
    const r = await runChat(b.text, { pool, tenantId, customerRef, ...(card && { card }), paymentProviders: providers, paymentProvider: DEFAULT_PROVIDER });
    return send(200, { reply: r.reply, ledgerRow: r.ledgerRow, ...(r.held && { held: true }) });
  } catch (e) {
    console.error(e instanceof Error ? e.message : "error"); // never log the message text
    return send(500, { error: "simulator error" });
  }
}).listen(PORT, "127.0.0.1", () => console.error(`sim web on http://127.0.0.1:${PORT} (LLM_PROVIDER=${process.env.LLM_PROVIDER ?? "fixture"}, LLM_MODE=${process.env.LLM_MODE ?? "replay"}, payments=${DEFAULT_PROVIDER})`));
