# v1 tickets: demo-grade, real-channel, real-money product

Companion to `TICKETS.md` (v0, T0-T14) and `UI-TICKETS.md` (owner console). v1 has no committed pilot customer, so scope is set against a different bar than the PRD's "Paid (revenue share live)" stage: **a single tenant, run by Kartikay, that a stranger can actually use over real WhatsApp and really pay, hosted somewhere other than a laptop.** Full pilot compliance (T29) stays deferred until a real owner commits.

**Rules carried over:** every ticket is a vertical slice ending in something runnable. All data stays fictional/labelled except the infrastructure itself (a real Meta number, a real Cloud Run service, real test-mode payment rails).

**Sizes:** S ~1 day, M ~2-3 days, L ~4-5 days.

---

## Phase V1-A — Real channel, stable hosting

### V1 — Deploy: agent on Render, site on Vercel (code ready 2026-11-11; deploy pending)
- **Slice:** The agent (auth + chat + payments + playground) is now one process (`agent/src/server/serve.ts`, `pnpm serve`), deployed as a Render web service with a stable HTTPS URL. The Next.js site deploys to Vercel and proxies to that URL via `AGENT_URL` (`next.config.ts` rewrites + the two API routes) -- no more `cloudflared`, no URL that changes every restart.
- **Demo:** `curl https://<render-service>.onrender.com/health` from the public internet; Razorpay's webhook pointed at `https://<vercel-site>/api/webhooks/payments/razorpay` still collects.
- **Done when:** a payment made against the deployed URL flips to `collected`, same as the tunnel proved locally.
- **Depends on:** none. **Size:** M.
- **Needs from Kartikay:** a Render account (no card required for the free web-service tier) and a Vercel account; see `docs/DEPLOY.md` for the click-by-click steps.
- **Known tradeoff:** Render's free tier sleeps after 15 minutes idle; a webhook arriving during that window gets a slow (cold-start) response rather than a fast one. Razorpay/Stripe retry on timeout, so it recovers, but a paid Render tier removes the sleep if this becomes a problem.

### V2 — WhatsApp Cloud API adapter, sandbox number (T25, scoped)
- **Slice:** Real adapter behind the same `handleMessage` pipeline the simulator already uses: GET verify-token handshake, POST inbound message -> pipeline -> Cloud API send, `X-Hub-Signature-256` check against `WHATSAPP_APP_SECRET`.
- **Demo:** text the sandbox number from a phone; get a real priced quote back on WhatsApp; pay the Razorpay link it sends; see it collected.
- **Done when:** signature-invalid requests are rejected before touching the pipeline; the five sandbox test recipients can round-trip all four fictional cards.
- **Depends on:** V1. **Size:** M.
- **Needs from Kartikay:** Meta app + WhatsApp product added, sandbox test number, `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_APP_SECRET` (business verification status should be re-checked now).

---

## Phase V1-B — Owner console
(Same tickets as `UI-TICKETS.md`, reordered for v1 velocity; U6-U11 there stay post-v1 unless a real pilot needs them sooner.)

### V3 = U0+U1+U2 — Session gate, tenant-scoped API, app shell
Auth pages already exist (`/login`, `/account`); this adds org creation, `withTenant`-backed `/api/app/*`, and the nav shell.

### V4 = U3 — Inbox and thread detail
### V5 = U4 — Quote and ledger viewer with the chain-verify badge
### V6 = U5 — Escalation queue with takeover and handback

---

## Phase V1-C — Production plumbing
(Carried over from the known-gaps list; blocking for any traffic beyond manual demos.)

### V7 — Postgres job queue, per-thread ordering
Replaces synchronous same-request handling so WhatsApp webhooks ack fast and process in order per thread.

### V8 — Move LLM wording out of the DB transaction
Known gap from T6: currently runs inside the tenant transaction; fine for the simulator, not for real latency/lock time.

### V9 — Timer and digest scheduler
Replaces `pnpm sim tick` with a `/tick` endpoint hit by Cloud Scheduler (hold expiry, chasers, owner digest).

### V10 — LLM spend caps
Per-tenant per-day ceiling on Groq spend; refuse-to-holding-reply once hit, never a silent overspend.

---

## Phase V1-D — Harden the money path

### V11 — Quote validity re-checked inside the webhook, not just on re-ask
Today `requestPaymentLink` checks `validUntil` when a customer explicitly asks again; the webhook itself doesn't re-check at the moment of collection. Close that gap.

### V12 — Refund and failed-payment events; reconciliation
`payment.failed` / refund webhooks currently have no handling path; add typed ledger events and a way to see payment-vs-ledger drift.

### V13 — Stripe proven live end-to-end
Razorpay was paid for real today (test mode). Stripe's adapter has equivalent tests but has never taken a real test payment through `stripe listen` / a deployed endpoint. Prove it the same way.

---

## Ongoing, non-blocking

### V14 — Informal owner conversations
Not a formal T27 interview — any real person who quotes customers by hand (real-estate contacts are the nearest lead). Cheap signal on wording and pricing assumptions before investing further in V1-B/C.

---

## Suggested order
V1 -> V2 (real channel + stable hosting; the best demo material and it removes the tunnel pain we hit today) -> V3-V6 (console, second-biggest credibility lever) -> V7-V10 (plumbing, needed before anyone but Kartikay uses it) -> V11-V13 (money hardening) -> V14 alongside all of it, whenever a conversation is available.

## Explicitly out of v1
T20 (voice), T21-T24 (Google Calendar/Sheets/Docs), T26 (React Router v8), full T29 pilot compliance (DR plan, access audit, independent security review), UI tickets U6-U11 (rate-card-in-app editing, payments view, settings, audit export, marketing truth pass).
