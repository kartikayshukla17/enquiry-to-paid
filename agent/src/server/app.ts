/**
 * The agent as one deployable HTTP process: Better Auth, the simulator/chat pipeline, payment webhooks and the
 * public playground, all in one server so a single host (e.g. one Render service) gives Razorpay/Stripe/the site
 * a single stable URL. Routes, in order: /api/auth/* (Better Auth) -> /api/app/* (tenant-scoped owner-console
 * read API, V3b) -> /health -> /webhooks/payments/:provider -> /payment-status -> /feedback -> /chat -> 404.
 * Binds to all interfaces; the caller picks the port.
 */
import { readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { toNodeHandler } from "better-auth/node";
import type { Pool } from "pg";
import { createAuth, type AuthOptions } from "../auth/index.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { verifyLedger } from "../ledger/index.js";
import { webhookHttpStatus } from "../payments/http.js";
import type { ProviderRegistry } from "../payments/registry.js";
import { handleProviderWebhook } from "../payments/webhook.js";
import { decryptPii, piiKeysFromEnv, type PiiKeys } from "../security/pii.js";
import { runChat } from "../simulator/chat.js";
import { checkAndBumpUsage, hashVisitorIp, recordFeedback } from "../simulator/playground.js";
import { REPO_ROOT } from "../ratecard/paths.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { describeLedgerEntry } from "./describe-ledger-entry.js";
import { maskCustomerRef } from "./mask-customer-ref.js";

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

/** Node's plain request-headers object, as a Fetch `Headers` instance -- what `auth.api.*` server calls expect. */
function fetchHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  return h;
}

/**
 * The /api/app/* response shapes. Exported so the console pages can rely on them verbatim.
 * `maskedCustomerRef` (V4) is computed server-side only, from `customers.phone_enc`, through
 * `maskCustomerRef` below -- the decrypted raw value never leaves `maskedRef`. `lastMessageSummary`
 * (V4) is a short, typed-data-only description of the thread's latest ledger entry, from
 * `describeLedgerEntry`; `null` only when a thread somehow has zero entries.
 */
export interface AppThreadSummary {
  id: string;
  state: string;
  createdAt: string;
  customerId: string;
  maskedCustomerRef: string;
  lastMessageSummary: string | null;
}
export interface AppThreadDetail extends AppThreadSummary {
  fields: unknown;
}
export interface AppLedgerEntryView {
  seq: number;
  at: string;
  type: string;
  payload: unknown;
  rateCardHash: string | null;
  modelId: string | null;
  provider: string | null;
  region: string | null;
  costMinor: number | null;
  /** V4: the same one-line, typed-data-only description `AppThreadSummary.lastMessageSummary` uses
   *  for this entry, from `describeLedgerEntry` -- computed once here so the thread detail screen
   *  and the inbox list never run two different descriptions of the same row. */
  summary: string;
}
export interface AppPaymentView {
  id: string;
  threadId: string;
  provider: string;
  amountMinor: number;
  currency: string;
  status: string;
  createdAt: string;
  collectedAt: string | null;
}

/**
 * V5: one row of the quotes list. `total`/`currency`/`validUntil` are read straight off the ledger
 * payload (a `quote`'s typed `Quote.total`/`currency`/`validUntil`, or an `owner_quote`'s
 * `ownerPriced`-shaped `total`/`currency` -- `owner_quote` has no `validUntil`, hence `null`). No
 * arithmetic happens here; these are exactly the stored fields, narrowed by type only.
 */
export interface AppQuoteSummary {
  seq: number;
  threadId: string | null;
  type: "quote" | "owner_quote";
  at: string;
  total: number | null;
  currency: string | null;
  validUntil: string | null;
}

/**
 * V5: the full quote detail. `payload` is the ledger row's typed payload verbatim -- the kernel's own
 * `Quote` (lines, ruleIds, adjustments, rateCardHash, total, currency, validUntil) for a `quote`, or the
 * `{ ownerPriced: true, total, currency, ... }` shape for an `owner_quote` -- never reconstructed or
 * summarised. `rateCardVersion` is the separately looked-up `rate_cards.version` for `payload.rateCardHash`
 * (a `quote` only); `null` means "unknown" -- either this is an `owner_quote` (no rate card at all) or no
 * `rate_cards` row matches that hash.
 */
export interface AppQuoteDetail {
  seq: number;
  threadId: string | null;
  type: "quote" | "owner_quote";
  at: string;
  payload: unknown;
  rateCardVersion: number | null;
}

/** The chain-verify badge's response. `ok:false` carries the real `LedgerVerdict`'s reason/seq/tenantSeq
 *  (never the whole multi-tenant `tenants` array -- the caller only ever asks about their own tenant). */
export interface AppLedgerVerifyResponse {
  ok: boolean;
  reason?: string;
  seq?: number;
  tenantSeq?: number;
}

function numberField(p: Record<string, unknown>, field: string): number | null {
  const v = p[field];
  return typeof v === "number" ? v : null;
}
function stringField(p: Record<string, unknown>, field: string): string | null {
  const v = p[field];
  return typeof v === "string" ? v : null;
}
function asPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

async function listAppQuotes(pool: Pool, tenantId: string): Promise<{ quotes: AppQuoteSummary[] }> {
  const { rows } = await withTenant(pool, tenantId, (c) =>
    c.query<{ seq: number; thread_id: string | null; type: string; at: Date; payload: unknown }>(
      `SELECT seq::int AS seq, thread_id, type, at, payload
         FROM ledger_entries WHERE tenant_id=$1 AND type IN ('quote','owner_quote') ORDER BY seq DESC`,
      [tenantId],
    ),
  );
  return {
    quotes: rows.map((r) => {
      const p = asPayloadRecord(r.payload);
      return {
        seq: r.seq,
        threadId: r.thread_id,
        type: r.type as "quote" | "owner_quote",
        at: r.at.toISOString(),
        total: numberField(p, "total"),
        currency: stringField(p, "currency"),
        validUntil: stringField(p, "validUntil"),
      };
    }),
  };
}

/** Undefined when `seq` does not resolve to a quote/owner_quote entry visible under this tenant --
 *  wrong tenant, a non-quote entry type, or nonexistent alike (identical 404 discipline to threads). */
async function getAppQuote(pool: Pool, tenantId: string, seq: number): Promise<{ quote: AppQuoteDetail } | undefined> {
  return withTenant(pool, tenantId, async (c) => {
    const row = (
      await c.query<{ seq: number; thread_id: string | null; type: string; at: Date; payload: unknown; rate_card_hash: string | null }>(
        `SELECT seq::int AS seq, thread_id, type, at, payload, rate_card_hash
           FROM ledger_entries WHERE tenant_id=$1 AND seq=$2 AND type IN ('quote','owner_quote')`,
        [tenantId, seq],
      )
    ).rows[0];
    if (!row) return undefined;
    let rateCardVersion: number | null = null;
    if (row.type === "quote" && row.rate_card_hash) {
      const v = (
        await c.query<{ version: number }>(
          "SELECT version::int AS version FROM rate_cards WHERE tenant_id=$1 AND content_hash=$2 ORDER BY version DESC LIMIT 1",
          [tenantId, row.rate_card_hash],
        )
      ).rows[0];
      rateCardVersion = v ? v.version : null;
    }
    return {
      quote: {
        seq: row.seq,
        threadId: row.thread_id,
        type: row.type as "quote" | "owner_quote",
        at: row.at.toISOString(),
        payload: row.payload,
        rateCardVersion,
      },
    };
  });
}

/**
 * The chain-verify badge's one real data source: calls the actual `verifyLedger` (kernel-backed hash
 * walk), scoped to exactly the caller's tenant, on the plain owner-role pool -- same calling convention
 * as `ledger/cli.ts`'s `pnpm ledger verify`, not wrapped in `withTenant`. `resolveAppCaller` is already
 * the proof the caller may see this tenant; `verifyLedger` is told exactly one tenant id and reads
 * nothing else, so no second RLS layer is needed around it.
 */
async function appLedgerVerify(pool: Pool, kernel: KernelBridge, tenantId: string): Promise<AppLedgerVerifyResponse> {
  const v = await verifyLedger(pool, kernel, { tenantId });
  if (v.ok) return { ok: true };
  return {
    ok: false,
    reason: v.reason,
    ...(v.seq !== null && { seq: v.seq }),
    ...(v.tenantSeq !== null && { tenantSeq: v.tenantSeq }),
  };
}

type AppCaller = { ok: true; tenantId: string } | { ok: false; status: 401 | 403; body: { error: string } };

/**
 * Resolves who is allowed to call /api/app/* -- and which tenant they may see -- from the session alone.
 * Never from anything the client sends: no header, query param or body field is ever consulted here.
 * `activeOrganizationId` lives in the session row itself (set server-side by Better Auth's own
 * organization/create and organization/set-active, see agent/src/auth/index.ts); organization.id IS the
 * tenant id everywhere else in this codebase. The owner check reads this APP's own `members` table
 * (distinct from Better Auth's `member` table) through `withTenant`, i.e. under RLS for that tenant --
 * v1 has exactly one real operator, so "owner" is the whole gate; manager/staff enforcement is not v1's job.
 */
async function resolveAppCaller(pool: Pool, auth: ReturnType<typeof createAuth>, req: IncomingMessage): Promise<AppCaller> {
  const session = await auth.api.getSession({ headers: fetchHeaders(req) });
  const tenantId = session?.session.activeOrganizationId;
  if (!session || !tenantId) return { ok: false, status: 401, body: { error: "not signed in" } };
  const role = await withTenant(pool, tenantId, async (c) =>
    (await c.query<{ role: string }>("SELECT role FROM members WHERE tenant_id=$1 AND user_id=$2", [tenantId, session.user.id])).rows[0]?.role,
  );
  if (role !== "owner") return { ok: false, status: 403, body: { error: "owner only" } };
  return { ok: true, tenantId };
}

/**
 * Decrypts `phone_enc` and masks it -- the ONLY place the decrypted raw value is allowed to exist.
 * A customer row with no ciphertext yet, or ciphertext that fails to decrypt, masks an empty
 * string rather than throwing: `maskCustomerRef` never returns blank, so the caller still gets a
 * safe, non-empty display value instead of a crash or a leak.
 */
function maskedRef(phoneEnc: string | null, pii: PiiKeys): string {
  if (!phoneEnc) return maskCustomerRef("");
  try {
    return maskCustomerRef(decryptPii(pii, phoneEnc));
  } catch {
    return maskCustomerRef("");
  }
}

async function listAppThreads(pool: Pool, tenantId: string): Promise<{ threads: AppThreadSummary[] }> {
  const pii = piiKeysFromEnv();
  const { rows } = await withTenant(pool, tenantId, (c) =>
    c.query<{
      id: string; state: string; created_at: Date; customer_id: string; phone_enc: string | null;
      last_type: string | null; last_payload: unknown;
    }>(
      `SELECT t.id, t.state, t.created_at, t.customer_id, c.phone_enc, le.type AS last_type, le.payload AS last_payload
         FROM threads t
         JOIN customers c ON c.id = t.customer_id AND c.tenant_id = t.tenant_id
         LEFT JOIN LATERAL (
           SELECT type, payload FROM ledger_entries
            WHERE tenant_id = t.tenant_id AND thread_id = t.id
            ORDER BY seq DESC LIMIT 1
         ) le ON true
        WHERE t.tenant_id=$1
        ORDER BY t.created_at DESC`,
      [tenantId],
    ),
  );
  return {
    threads: rows.map((r) => ({
      id: r.id,
      state: r.state,
      createdAt: r.created_at.toISOString(),
      customerId: r.customer_id,
      maskedCustomerRef: maskedRef(r.phone_enc, pii),
      lastMessageSummary: r.last_type ? describeLedgerEntry({ type: r.last_type, payload: r.last_payload }) : null,
    })),
  };
}

/** Undefined when `:id` does not resolve to a row visible under this tenant -- wrong tenant or nonexistent alike. */
async function getAppThread(pool: Pool, tenantId: string, threadId: string): Promise<{ thread: AppThreadDetail; entries: AppLedgerEntryView[] } | undefined> {
  const pii = piiKeysFromEnv();
  return withTenant(pool, tenantId, async (c) => {
    const t = (
      await c.query<{ id: string; state: string; created_at: Date; customer_id: string; fields: unknown; phone_enc: string | null }>(
        `SELECT t.id, t.state, t.created_at, t.customer_id, t.fields, c.phone_enc
           FROM threads t JOIN customers c ON c.id = t.customer_id AND c.tenant_id = t.tenant_id
          WHERE t.tenant_id=$1 AND t.id=$2`,
        [tenantId, threadId],
      )
    ).rows[0];
    if (!t) return undefined;
    const { rows } = await c.query<{
      seq: number; at: Date; type: string; payload: unknown; rate_card_hash: string | null;
      model_id: string | null; provider: string | null; region: string | null; cost_minor: number | null;
    }>(
      `SELECT seq::int AS seq, at, type, payload, rate_card_hash, model_id, provider, region, cost_minor::int AS cost_minor
         FROM ledger_entries WHERE tenant_id=$1 AND thread_id=$2 ORDER BY seq ASC`,
      [tenantId, threadId],
    );
    const entries = rows.map((e) => ({
      seq: e.seq, at: e.at.toISOString(), type: e.type, payload: e.payload, rateCardHash: e.rate_card_hash,
      modelId: e.model_id, provider: e.provider, region: e.region, costMinor: e.cost_minor,
      summary: describeLedgerEntry({ type: e.type, payload: e.payload }),
    }));
    const last = entries[entries.length - 1];
    return {
      thread: {
        id: t.id,
        state: t.state,
        createdAt: t.created_at.toISOString(),
        customerId: t.customer_id,
        fields: t.fields,
        maskedCustomerRef: maskedRef(t.phone_enc, pii),
        lastMessageSummary: last ? last.summary : null,
      },
      entries,
    };
  });
}

async function listAppPayments(pool: Pool, tenantId: string): Promise<{ payments: AppPaymentView[] }> {
  const { rows } = await withTenant(pool, tenantId, (c) =>
    c.query<{
      id: string; thread_id: string; provider: string; amount_minor: number; currency: string;
      status: string; created_at: Date; collected_at: Date | null;
    }>(
      `SELECT id, thread_id, provider, amount_minor::int AS amount_minor, currency, status, created_at, collected_at
         FROM payments WHERE tenant_id=$1 ORDER BY created_at DESC`,
      [tenantId],
    ),
  );
  return {
    payments: rows.map((p) => ({
      id: p.id, threadId: p.thread_id, provider: p.provider, amountMinor: p.amount_minor, currency: p.currency,
      status: p.status, createdAt: p.created_at.toISOString(), collectedAt: p.collected_at ? p.collected_at.toISOString() : null,
    })),
  };
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
  const auth = createAuth(deps.pool, deps.auth ?? {});
  const authHandler = toNodeHandler(auth);

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
      if (req.url?.startsWith("/api/app/")) {
        // Every /api/app/* route is read-only: session -> active org (the tenant id, never client-supplied) ->
        // owner-only in this app's own `members` table -> withTenant (RLS). The query string and body are never
        // consulted for identity, only `pathname` for routing -- that is the Done-when this ticket proves.
        const { pathname } = new URL(req.url, "http://x");
        const caller = await resolveAppCaller(deps.pool, auth, req);
        if (!caller.ok) return send(caller.status, caller.body);
        if (req.method !== "GET") return send(404, { error: "not found" });
        if (pathname === "/api/app/threads") return send(200, await listAppThreads(deps.pool, caller.tenantId));
        if (pathname === "/api/app/payments") return send(200, await listAppPayments(deps.pool, caller.tenantId));
        if (pathname === "/api/app/quotes") return send(200, await listAppQuotes(deps.pool, caller.tenantId));
        if (pathname === "/api/app/ledger-verify") return send(200, await appLedgerVerify(deps.pool, deps.kernel, caller.tenantId));
        const threadMatch = /^\/api\/app\/threads\/([^/]+)$/.exec(pathname);
        if (threadMatch) {
          const result = await getAppThread(deps.pool, caller.tenantId, decodeURIComponent(threadMatch[1]!));
          return result ? send(200, result) : send(404, { error: "not found" });
        }
        const quoteMatch = /^\/api\/app\/quotes\/([^/]+)$/.exec(pathname);
        if (quoteMatch) {
          const seq = Number(decodeURIComponent(quoteMatch[1]!));
          if (!Number.isInteger(seq) || seq <= 0) return send(404, { error: "not found" });
          const result = await getAppQuote(deps.pool, caller.tenantId, seq);
          return result ? send(200, result) : send(404, { error: "not found" });
        }
        return send(404, { error: "not found" });
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
