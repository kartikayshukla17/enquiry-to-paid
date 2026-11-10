/**
 * The agent as one deployable HTTP process: Better Auth, the simulator/chat pipeline, payment webhooks and the
 * public playground, all in one server so a single host (e.g. one Render service) gives Razorpay/Stripe/the site
 * a single stable URL. Routes, in order: /api/auth/* (Better Auth) -> /health -> /webhooks/payments/:provider ->
 * /payment-status -> /feedback -> /chat -> 404. Binds to all interfaces; the caller picks the port.
 */
import { readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { toNodeHandler } from "better-auth/node";
import type { Pool } from "pg";
import { createAuth, type AuthOptions } from "../auth/index.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { webhookHttpStatus } from "../payments/http.js";
import type { ProviderRegistry } from "../payments/registry.js";
import { handleProviderWebhook } from "../payments/webhook.js";
import { runChat } from "../simulator/chat.js";
import { checkAndBumpUsage, hashVisitorIp, recordFeedback } from "../simulator/playground.js";
import { REPO_ROOT } from "../ratecard/paths.js";
import { withTenant } from "../tenancy/with-tenant.js";

const MAX_BODY = 8 * 1024;
const MAX_WEBHOOK_BODY = 256 * 1024;

const CARDS = new Set(
  readdirSync(`${REPO_ROOT}rate-cards`)
    .filter((f) => /^fictional-.*\.json$/.test(f))
    .map((f) => `rate-cards/${f}`),
);

/** Each fictional card gets its own tenant so threads and approvals never mix across verticals. */
export const tenantForCard = (card?: string): string => (card ? `tenant-web-${card.split("fictional-")[1]!.replace(".json", "")}` : "tenant-rose-court");

function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string> {
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

function visitorIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

export interface AppServerDeps {
  pool: Pool;
  kernel: KernelBridge;
  providers: ProviderRegistry;
  defaultProvider: string;
  /** HMAC key for playground visitor-IP hashing; never the raw IP is stored. */
  visitorIpKey: string;
  auth?: AuthOptions;
}

export function createAppServer(deps: AppServerDeps): Server {
  const authHandler = toNodeHandler(createAuth(deps.pool, deps.auth ?? {}));

  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.url?.startsWith("/api/auth/")) {
        void authHandler(req, res);
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        return send(200, { ok: true, provider: process.env.LLM_PROVIDER ?? "fixture", mode: process.env.LLM_MODE ?? "replay" });
      }
      const hook = req.method === "POST" ? /^\/webhooks\/payments\/([a-z-]{3,20})$/.exec(req.url ?? "") : null;
      if (hook) {
        const raw = await readBody(req, MAX_WEBHOOK_BODY);
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
        const r = await handleProviderWebhook({ pool: deps.pool, kernel: deps.kernel, providers: deps.providers }, hook[1]!, raw, headers, new Date().toISOString());
        console.error(`[webhook] ${hook[1]} -> ${r.status}${"reason" in r ? ` (${r.reason})` : ""}`);
        return send(webhookHttpStatus(r), { status: r.status });
      }
      if (req.method === "GET" && req.url?.startsWith("/payment-status")) {
        const q = new URL(req.url, "http://x").searchParams;
        const card = q.get("card") ?? undefined;
        const ref = q.get("customerRef") ?? "";
        if (!/^[a-z0-9-]{4,40}$/.test(ref) || (card && !CARDS.has(card))) return send(400, { error: "bad request" });
        const tenantId = tenantForCard(card);
        const row = await withTenant(deps.pool, tenantId, async (c) =>
          (
            await c.query(
              "SELECT provider, status, amount_minor::text AS amount_minor, currency, link_url FROM payments WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 1",
              [`${tenantId}:thread:chat:${ref}`],
            )
          ).rows[0],
        );
        return send(200, { payment: row ?? null });
      }
      if (req.method === "POST" && req.url === "/feedback") {
        const f = JSON.parse(await readBody(req)) as { card?: unknown; rating?: unknown; comment?: unknown };
        if (typeof f.card !== "string" || !CARDS.has(f.card)) return send(400, { error: "unknown card" });
        if (f.rating !== "up" && f.rating !== "down") return send(400, { error: "rating must be 'up' or 'down'" });
        if (f.comment !== undefined && (typeof f.comment !== "string" || f.comment.length > 1000)) return send(400, { error: "comment must be at most 1000 characters" });
        await recordFeedback(deps.pool, { card: f.card, rating: f.rating, now: new Date().toISOString(), ...(typeof f.comment === "string" && f.comment.trim() && { comment: f.comment.trim() }) });
        return send(200, { ok: true });
      }
      if (req.method !== "POST" || req.url !== "/chat") return send(404, { error: "not found" });
      const ipHash = hashVisitorIp(visitorIp(req), deps.visitorIpKey);
      const usage = await checkAndBumpUsage(deps.pool, ipHash, new Date().toISOString().slice(0, 10));
      if (!usage.ok) return send(429, { error: "Daily playground limit reached. Please come back tomorrow." });
      const b = JSON.parse(await readBody(req)) as { text?: unknown; customerRef?: unknown; card?: unknown };
      if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 1000) return send(400, { error: "text must be 1-1000 characters" });
      const customerRef = typeof b.customerRef === "string" && /^[a-z0-9-]{4,40}$/.test(b.customerRef) ? b.customerRef : "web-sim-customer";
      const card = typeof b.card === "string" && CARDS.has(b.card) ? b.card : undefined;
      const tenantId = tenantForCard(card);
      const r = await runChat(b.text, { pool: deps.pool, tenantId, customerRef, ...(card && { card }), paymentProviders: deps.providers, paymentProvider: deps.defaultProvider });
      return send(200, { reply: r.reply, ledgerRow: r.ledgerRow, ...(r.held && { held: true }) });
    } catch (e) {
      console.error(e instanceof Error ? e.message : "error"); // never log the message text
      return send(500, { error: "server error" });
    }
  });
}
