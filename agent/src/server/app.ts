/**
 * The agent as one deployable HTTP process: Better Auth, the simulator/chat pipeline, payment webhooks and the
 * public playground, all in one server so a single host (e.g. one Render service) gives Razorpay/Stripe/the site
 * a single stable URL. Routes, in order: /api/auth/* (Better Auth) -> /api/app/* (tenant-scoped owner-console
 * read API, V3b) -> /health -> /tick (V7) -> /webhooks/payments/:provider -> /webhooks/whatsapp (V2, GET
 * handshake + POST inbound) -> /payment-status -> /feedback -> /chat -> 404. Binds to all interfaces; the
 * caller picks the port.
 */
import { timingSafeEqual } from "node:crypto";
import { readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { toNodeHandler } from "better-auth/node";
import type { Pool, PoolClient } from "pg";
import { createAuth, type AuthOptions } from "../auth/index.js";
import { collectingChaserOutbox, type ChaserMessage } from "../chasers/types.js";
import { describeReason } from "../escalation/index.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { verifyLedger } from "../ledger/index.js";
import type { Member } from "../owner/members.js";
import { ensureOpsThread } from "../owner/handle.js";
import { sendDailyDigest } from "../owner/inbound.js";
import { pushRecipients } from "../owner/members.js";
import { listOpenRefusals } from "../owner/queue.js";
import { handbackInTxn, ownerReplyInTxn, threadRef } from "../owner/takeover.js";
import { collectingOutbox, type OwnerOutgoing } from "../owner/types.js";
import { webhookHttpStatus } from "../payments/http.js";
import type { ProviderRegistry } from "../payments/registry.js";
import { handleProviderWebhook } from "../payments/webhook.js";
import { decryptPii, piiKeysFromEnv, type PiiKeys } from "../security/pii.js";
import { runChat } from "../simulator/chat.js";
import { checkAndBumpUsage, hashVisitorIp, recordFeedback } from "../simulator/playground.js";
import { REPO_ROOT } from "../ratecard/paths.js";
import { runDueTimers } from "../timers/run.js";
import { withTenant } from "../tenancy/with-tenant.js";
import type { WhatsAppConfig } from "../whatsapp/config.js";
import { verifyHandshake } from "../whatsapp/handshake.js";
import { whatsappWebhookHttpStatus } from "../whatsapp/http.js";
import { sendWhatsAppText } from "../whatsapp/send.js";
import { handleWhatsAppWebhook } from "../whatsapp/webhook.js";
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
  /** V12: `ledger_entries.seq` of the quote this payment was issued for -- the join key the quote detail
   *  page's reconciliation view uses to find "the payment(s) for THIS quote" without re-deriving it. */
  quoteLedgerSeq: number;
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

/**
 * V6: one row of the escalation queue -- `owner/queue.ts`'s `listOpenRefusals` (the latest refusal on
 * each thread still `refused`), reshaped for the wire. `reason` is the raw closed-set code (same as
 * every other typed payload field this API exposes verbatim); `reasonText` is the owner-facing
 * sentence, computed server-side via `escalation/index.ts`'s `describeReason` so the site never
 * re-derives the wording V4's `describeLedgerEntry`-based summaries already established the pattern
 * for. `at` is the refusal's ledger timestamp ("age") -- the site computes "2h ago" from it; a second
 * "ageSeconds as of request time" field would just be presentation duplicated onto the wire.
 */
export interface AppEscalationSummary {
  tenantSeq: number;
  seq: number;
  threadId: string;
  reason: string;
  reasonText: string;
  ruleGap?: string;
  suggestion?: string;
  at: string;
  calledBack: boolean;
}

/** The takeover/handback actions' response: the owner-channel function's own reply text, plus the
 *  thread's new state so the console can refresh its view without a second round trip. */
export interface AppOwnerActionResponse {
  reply: string;
  threadState: string;
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

/**
 * V6: the escalation queue -- `owner/queue.ts`'s `listOpenRefusals` (EXACTLY the owner-channel's own
 * data source for "what is waiting for me"), wrapped in `withTenant` the same way every other
 * /api/app/* list route is. `reasonText` is computed here, server-side, via the same `describeReason`
 * the owner-channel's `why`/digest replies already use, so the site never re-derives the wording.
 */
async function listAppEscalations(pool: Pool, tenantId: string): Promise<{ escalations: AppEscalationSummary[] }> {
  const open = await withTenant(pool, tenantId, (c) => listOpenRefusals(c, tenantId));
  return {
    escalations: open.map((o) => ({
      tenantSeq: o.tenantSeq,
      seq: o.seq,
      threadId: o.threadId,
      reason: o.reason,
      reasonText: describeReason(o.reason),
      ...(o.ruleGap !== undefined && { ruleGap: o.ruleGap }),
      ...(o.suggestion !== undefined && { suggestion: o.suggestion }),
      at: o.at,
      calledBack: o.calledBack,
    })),
  };
}

/**
 * V6: resolves `:id` to a thread under this tenant and its current ref (`threadRef` -- the newest
 * refusal/quote/owner_quote on it), plus the tenant's real name for `ensureOpsThread`/`ownerReplyInTxn`'s
 * `ctx.tenant`. `undefined` for a thread id that does not resolve under this tenant OR has no ref yet
 * (every thread the escalation queue ever lists has a refusal, so this is only reachable by calling
 * these routes on some other thread that has never been refused/quoted -- there is nothing to take
 * over there either, so the same 404 applies). Caller already holds the transaction (`c`); this never
 * opens its own.
 */
async function resolveThreadForOwnerAction(c: PoolClient, tenantId: string, threadId: string): Promise<{ tenant: { id: string; name: string }; ref: string } | undefined> {
  const t = (await c.query<{ id: string }>("SELECT id FROM threads WHERE tenant_id=$1 AND id=$2", [tenantId, threadId])).rows[0];
  if (!t) return undefined;
  const ref = await threadRef(c, tenantId, threadId);
  if (!ref) return undefined;
  const tenantRow = (await c.query<{ name: string }>("SELECT name FROM tenants WHERE id=$1", [tenantId])).rows[0];
  return { tenant: { id: tenantId, name: tenantRow?.name ?? tenantId }, ref };
}

/**
 * V6: "take over and reply" -- `owner/takeover.ts`'s `ownerReplyInTxn`, called with the HTTP caller's
 * own member row (never a looked-up arbitrary one) as the acting member. Calling this again on an
 * already-paused thread is fine and expected: it sends another message and does not double-pause or
 * double-log a `pause` entry (that discipline lives in `ownerReplyInTxn` itself, reused verbatim).
 * `undefined` means the thread id did not resolve under this tenant (or has no ref yet) -- a 404.
 */
async function appTakeover(pool: Pool, kernel: KernelBridge, tenantId: string, member: Member, threadId: string, text: string): Promise<AppOwnerActionResponse | undefined> {
  return withTenant(pool, tenantId, async (c) => {
    const resolved = await resolveThreadForOwnerAction(c, tenantId, threadId);
    if (!resolved) return undefined;
    const opsThreadId = await ensureOpsThread(c, resolved.tenant, piiKeysFromEnv());
    const r = await ownerReplyInTxn(c, kernel, { tenant: resolved.tenant, member, now: new Date().toISOString(), opsThreadId }, { ref: resolved.ref, text });
    const threadState = (await c.query<{ state: string }>("SELECT state FROM threads WHERE id=$1", [threadId])).rows[0]!.state;
    return { reply: r.reply, threadState };
  });
}

/** V6: hands a paused thread back -- `owner/takeover.ts`'s `handbackInTxn`, with the ref this route
 *  already knows from the URL (never the ambiguity-resolution "guess which thread" path, which is
 *  only for the WhatsApp owner channel's "handback" with no ref). `undefined` means 404, same as
 *  `appTakeover`; "not paused" etc. is `handbackInTxn`'s own normal (200) outcome, not an error here. */
async function appHandback(pool: Pool, kernel: KernelBridge, tenantId: string, member: Member, threadId: string): Promise<AppOwnerActionResponse | undefined> {
  return withTenant(pool, tenantId, async (c) => {
    const resolved = await resolveThreadForOwnerAction(c, tenantId, threadId);
    if (!resolved) return undefined;
    const opsThreadId = await ensureOpsThread(c, resolved.tenant, piiKeysFromEnv());
    const r = await handbackInTxn(c, kernel, { tenant: resolved.tenant, member, now: new Date().toISOString(), opsThreadId }, { ref: resolved.ref });
    const threadState = (await c.query<{ state: string }>("SELECT state FROM threads WHERE id=$1", [threadId])).rows[0]!.state;
    return { reply: r.reply, threadState };
  });
}

type AppCaller = { ok: true; tenantId: string; memberId: string } | { ok: false; status: 401 | 403; body: { error: string } };

/**
 * Resolves who is allowed to call /api/app/* -- which tenant they may see, and (V6) their own
 * `members.id` -- from the session alone. Never from anything the client sends: no header, query
 * param or body field is ever consulted here. `activeOrganizationId` lives in the session row itself
 * (set server-side by Better Auth's own organization/create and organization/set-active, see
 * agent/src/auth/index.ts); organization.id IS the tenant id everywhere else in this codebase. The
 * owner check reads this APP's own `members` table (distinct from Better Auth's `member` table)
 * through `withTenant`, i.e. under RLS for that tenant -- v1 has exactly one real operator, so "owner"
 * is the whole gate; manager/staff enforcement is not v1's job. `memberId` is this same row's `id`
 * (the Better Auth member id, which is exactly what `ownerReplyInTxn`/`handbackInTxn` want to name as
 * the acting member) -- V6's takeover/handback routes need it; no second lookup is added for them.
 */
async function resolveAppCaller(pool: Pool, auth: ReturnType<typeof createAuth>, req: IncomingMessage): Promise<AppCaller> {
  const session = await auth.api.getSession({ headers: fetchHeaders(req) });
  const tenantId = session?.session.activeOrganizationId;
  if (!session || !tenantId) return { ok: false, status: 401, body: { error: "not signed in" } };
  const member = await withTenant(pool, tenantId, async (c) =>
    (await c.query<{ id: string; role: string }>("SELECT id, role FROM members WHERE tenant_id=$1 AND user_id=$2", [tenantId, session.user.id])).rows[0],
  );
  if (member?.role !== "owner") return { ok: false, status: 403, body: { error: "owner only" } };
  return { ok: true, tenantId, memberId: member.id };
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
      id: string; thread_id: string; quote_ledger_seq: number; provider: string; amount_minor: number; currency: string;
      status: string; created_at: Date; collected_at: Date | null;
    }>(
      `SELECT id, thread_id, quote_ledger_seq::int AS quote_ledger_seq, provider, amount_minor::int AS amount_minor,
              currency, status, created_at, collected_at
         FROM payments WHERE tenant_id=$1 ORDER BY created_at DESC`,
      [tenantId],
    ),
  );
  return {
    payments: rows.map((p) => ({
      id: p.id, threadId: p.thread_id, quoteLedgerSeq: p.quote_ledger_seq, provider: p.provider, amountMinor: p.amount_minor,
      currency: p.currency, status: p.status, createdAt: p.created_at.toISOString(), collectedAt: p.collected_at ? p.collected_at.toISOString() : null,
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
  /**
   * V7: the shared secret `POST /tick` requires (env `TICK_SECRET`). Undefined (not configured on this
   * deployment) means `/tick` always 401s -- due work is never silently skipped as if nothing were due,
   * it is refused outright until an operator sets the secret.
   */
  tickSecret?: string;
  /**
   * V2: the four WhatsApp Cloud API credentials (`whatsappConfigFromEnv()`), or undefined on a deployment
   * that has not configured WhatsApp yet. Undefined (or any individual field being `""`) means `/webhooks/
   * whatsapp` always 403s/401s -- it never crashes, same posture as `tickSecret` being unset for `/tick`.
   */
  whatsapp?: WhatsAppConfig;
}

/**
 * V7: `POST /tick`'s shared-secret check -- `Authorization: Bearer <TICK_SECRET>`, compared in constant
 * time (`timingSafeEqual`, same discipline the payment webhook signature checks use in
 * `payments/*-sim.ts`). `timingSafeEqual` throws on a length mismatch rather than returning false, so
 * the length check runs first; this test is not itself constant-time, but it leaks only the attempted
 * secret's length, never anything about its content. No `secret` configured on this deployment (the env
 * var `TICK_SECRET` unset) always fails closed, whatever the header says.
 */
function tickAuthorized(req: IncomingMessage, secret: string | undefined): boolean {
  if (!secret) return false;
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * V7: the owner digest's due-check, for every tenant that exists (not just ones with recent activity).
 * `pool` is the owner-role connection (bypasses RLS, same as `verifyLedger`/`killswitch` -- enumerating
 * tenant ids and the latest `digest_sent` entry per tenant are read-only, cross-tenant lookups, not a
 * tenant-scoped write). A tenant is skipped, with no digest and no ledger entry, when its last
 * `digest_sent` is under 24h old (by the server's real clock) OR it has nobody to push to at all
 * (`pushRecipients` empty) -- `sendDailyDigest` itself has no idempotency and no recipient check, so
 * both gates live here, before it is ever called.
 */
async function sendDueDigests(pool: Pool, kernel: KernelBridge, now: string): Promise<number> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const tenants = (await pool.query<{ id: string; name: string }>("SELECT id, name FROM tenants ORDER BY id")).rows;
  const lastSent = new Map(
    (
      await pool.query<{ tenant_id: string; last_sent: Date }>(
        "SELECT tenant_id, MAX(at) AS last_sent FROM ledger_entries WHERE type='owner_message' AND payload->>'command'='digest_sent' GROUP BY tenant_id",
      )
    ).rows.map((r) => [r.tenant_id, r.last_sent]),
  );
  const nowMs = Date.parse(now);
  let sent = 0;
  for (const tenant of tenants) {
    const last = lastSent.get(tenant.id);
    if (last && nowMs - last.getTime() < DAY_MS) continue; // sent recently enough: not due
    const recipients = await withTenant(pool, tenant.id, (c) => pushRecipients(c, tenant.id));
    if (recipients.length === 0) continue; // nobody to send it to: no entry, not "sent to nobody"
    const sink: OwnerOutgoing[] = [];
    await sendDailyDigest({ pool, outbox: collectingOutbox(sink), kernel }, { tenant, now });
    sent += 1;
  }
  return sent;
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

        // V6: the two write routes (takeover, handback) -- everything else under /api/app/* is GET-only
        // (checked right below), so these are matched and handled before that blanket gate.
        const takeoverMatch = /^\/api\/app\/threads\/([^/]+)\/takeover$/.exec(pathname);
        if (req.method === "POST" && takeoverMatch) {
          const b = JSON.parse(await readBody(req)) as { text?: unknown };
          if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 1000) return send(400, { error: "text must be 1-1000 characters" });
          const member: Member = { id: caller.memberId, role: "owner" };
          const result = await appTakeover(deps.pool, deps.kernel, caller.tenantId, member, decodeURIComponent(takeoverMatch[1]!), b.text.trim());
          return result ? send(200, result) : send(404, { error: "not found" });
        }
        const handbackMatch = /^\/api\/app\/threads\/([^/]+)\/handback$/.exec(pathname);
        if (req.method === "POST" && handbackMatch) {
          const member: Member = { id: caller.memberId, role: "owner" };
          const result = await appHandback(deps.pool, deps.kernel, caller.tenantId, member, decodeURIComponent(handbackMatch[1]!));
          return result ? send(200, result) : send(404, { error: "not found" });
        }

        if (req.method !== "GET") return send(404, { error: "not found" });
        if (pathname === "/api/app/threads") return send(200, await listAppThreads(deps.pool, caller.tenantId));
        if (pathname === "/api/app/payments") return send(200, await listAppPayments(deps.pool, caller.tenantId));
        if (pathname === "/api/app/quotes") return send(200, await listAppQuotes(deps.pool, caller.tenantId));
        if (pathname === "/api/app/escalations") return send(200, await listAppEscalations(deps.pool, caller.tenantId));
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
      // V7: called by the GitHub Actions schedule (no browser session), authenticated by shared secret instead
      // of the cookie-based /api/app/* gate. This is the ONLY place the deployed process ever runs due timers
      // or the owner digest -- nothing else here starts a background loop of its own (see no-scheduler.test.ts).
      if (req.method === "POST" && req.url === "/tick") {
        if (!tickAuthorized(req, deps.tickSecret)) return send(401, { error: "unauthorized" });
        const now = new Date().toISOString(); // the one place allowed to read the real clock directly
        const sink: ChaserMessage[] = [];
        const result = await runDueTimers(deps.pool, now, { kernel: deps.kernel, chaserOutbox: collectingChaserOutbox(sink) });
        const digestsSent = await sendDueDigests(deps.pool, deps.kernel, now);
        return send(200, { processed: result.processed, expiredHolds: result.expiredHolds.length, chasersSent: result.chasersSent.length, digestsSent });
      }
      const hook = req.method === "POST" ? /^\/webhooks\/payments\/([a-z-]{3,20})$/.exec(req.url ?? "") : null;
      if (hook) {
        const raw = await readBody(req, MAX_WEBHOOK_BODY);
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
        const r = await handleProviderWebhook({ pool: deps.pool, kernel: deps.kernel, providers: deps.providers }, hook[1]!, raw, headers, new Date().toISOString());
        console.error(`[webhook] ${hook[1]} -> ${r.status}${"reason" in r ? ` (${r.reason})` : ""}`);
        return send(webhookHttpStatus(r), { status: r.status });
      }
      // V2: WhatsApp Cloud API -- GET is Meta's one-time verify-token handshake, POST is the real webhook
      // (customer messages in, a pipeline reply out). `deps.whatsapp` absent (or any of its fields `""`,
      // unset env) means BOTH routes fail closed -- `verifyHandshake`/`handleWhatsAppWebhook` already treat
      // an empty secret/token as "never succeeds", never a crash.
      if (req.method === "GET" && req.url?.startsWith("/webhooks/whatsapp")) {
        const cfg = deps.whatsapp ?? { appSecret: "", verifyToken: "", token: "", phoneNumberId: "" };
        const q = new URL(req.url, "http://x").searchParams;
        const query: Record<string, string | undefined> = { "hub.mode": q.get("hub.mode") ?? undefined, "hub.verify_token": q.get("hub.verify_token") ?? undefined, "hub.challenge": q.get("hub.challenge") ?? undefined };
        const r = verifyHandshake(query, cfg.verifyToken);
        console.error(`[webhook] whatsapp handshake -> ${r.ok ? "ok" : "rejected"}`);
        if (!r.ok) return send(403, { error: "forbidden" });
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(r.challenge);
      }
      if (req.method === "POST" && req.url === "/webhooks/whatsapp") {
        const cfg = deps.whatsapp ?? { appSecret: "", verifyToken: "", token: "", phoneNumberId: "" };
        const raw = await readBody(req, MAX_WEBHOOK_BODY);
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
        const r = await handleWhatsAppWebhook(
          {
            pool: deps.pool,
            appSecret: cfg.appSecret,
            send: (to, body) => sendWhatsAppText({ token: cfg.token, phoneNumberId: cfg.phoneNumberId }, to, body),
            paymentProviders: deps.providers,
            paymentProvider: deps.defaultProvider,
          },
          raw,
          headers,
          new Date().toISOString(),
        );
        console.error(`[webhook] whatsapp -> ${r.status}${"reason" in r ? ` (${r.reason})` : ""}`);
        return send(whatsappWebhookHttpStatus(r), { status: r.status });
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
