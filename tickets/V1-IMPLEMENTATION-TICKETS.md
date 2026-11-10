# Implementation tickets: v1

Derived from `prd/V1-PRD.md`. Self-contained — every ticket below has its full body here, rather than pointing at `tickets/V1-TICKETS.md` or `UI-TICKETS.md` and making you cross-reference. Ticket IDs stay traceable to those files (`V3` there is split into `V3a`/`V3b`/`V3c` here, since "a tenant-scoped API, an app shell, and sign-up" is three separate vertical slices bundled under one number, not one).

**Rule, same as every ticket file in this repo:** every ticket cuts through every layer it touches and ends in something you can run and watch. No ticket here is "add a library" or "add a table" on its own.

**Sizes:** S ~1 day, M ~2-3 days, L ~4-5 days.

---

## Phase 1 — Owner console

### V3a — Session gate and real tenant sign-up
- **Slice:** Middleware protects `/app/*` (redirect to `/login`, already built). First sign-in with no organization lands on "Create your business" (Better Auth's organization-create, already wired in `agent/src/auth/index.ts`, exposed through a real UI form for the first time). The created org mirrors to `tenants`/`members` exactly as it already does today for any Better Auth organization.
- **Demo:** sign in with Google → fill in a business name → land on `/app`, empty.
- **Done when:** a second Google account creates a second, fully separate tenant; neither can read the other's data (reuses the existing RLS tests as the proof, no new isolation logic needed).
- **Depends on:** none (auth already built). **Size:** S.

### V3b — Tenant-scoped read API
- **Slice:** `/api/app/*` on the agent. Every request resolves session → active org → **owner role only for v1** (no staff/manager enforcement yet — there is exactly one real operator today), then runs every query through `withTenant` (RLS). Covers: list threads, get one thread's ledger entries, list payments.
- **Demo:** `curl` with a session cookie returns only that tenant's threads; the same call with another tenant's ids returns 404, never another tenant's row.
- **Done when:** a test proves no endpoint accepts a tenant id from the client — it's always derived from the session.
- **Depends on:** V3a. **Size:** M.

### V3c — App shell
- **Slice:** Layout with nav (Inbox, Quotes, Escalations), tenant name, a visible "test environment" banner, and a shared empty/loading/error-state kit for every screen below to reuse.
- **Demo:** every nav item routes to a working stub with a correct empty state; works at 375px width.
- **Done when:** keyboard-navigable, AA contrast, no horizontal scroll on phone (same bar as `DESIGN.md`).
- **Depends on:** V3a. **Size:** S.

### V4 — Inbox and thread detail
- **Slice:** List of threads (state, last message, masked customer ref — last 2-3 digits visible, never the full number, never nothing) with filters. Thread detail shows the conversation with each message's ledger row alongside it.
- **Demo:** run three conversations through the playground; all three appear in the inbox; open one and see every message with its ledger entry.
- **Done when:** a raw, unmasked phone number never reaches this screen, checked the same way v0's "never logs a raw phone number" tests already check the pipeline.
- **Depends on:** V3b, V3c. **Size:** M.

### V5 — Quote and ledger viewer with the chain-verify badge
- **Slice:** Each quote shown as line items with rule IDs, rate-card version/hash and `validUntil`. A badge calls the server's real `ledger verify` for that tenant and shows pass/fail — never a client-side guess at whether the chain is intact.
- **Demo:** open a quote, see its lines and rule IDs; tamper a row in a scratch database and watch the badge turn red on next load.
- **Done when:** every number on this screen traces back to a kernel-produced ledger payload — the page performs no arithmetic of its own.
- **Depends on:** V4. **Size:** M.

### V6 — Escalation queue with takeover and handback
- **Slice:** Open escalations (reason, rule gap, thread link, age) pulled from the playground's own real escalation events — this does not wait for a live channel. Owner can take over a thread, reply as themselves, hand back to the agent.
- **Demo:** trigger a discount-request escalation in the playground → it appears in the queue → take over → send a human reply → hand back, agent resumes.
- **Done when:** a test proves the agent sends nothing automatically while a thread is taken over; every action (takeover, reply, handback) is its own ledger row naming the acting member.
- **Depends on:** V4. **Size:** M.

---

## Phase 2 — Free-tier-safe plumbing

### V7 — `POST /tick`, scheduled by GitHub Actions, running real work
- **Slice:** A `/tick` endpoint on the deployed agent claims and processes due work — hold expiry, chaser sends, the owner digest — replacing `pnpm sim tick`. A scheduled GitHub Actions workflow (new file under `.github/workflows/`, reusing this repo's existing CI setup, no new third-party account) hits it every 5 minutes. Built this way specifically because Render's free tier has no background-worker or cron option at all — confirmed via Render's own staff, not assumed.
- **Demo:** place a hold with the workflow disabled; confirm it does not expire on schedule. Re-enable the workflow; confirm it expires within one tick.
- **Done when:** disabling the GitHub Actions workflow is the only thing that stops scheduled work — nothing else in the deployed service silently runs it on a timer of its own.
- **Depends on:** `V1` (the agent must already be deployed for a workflow to reach it). **Size:** M.

### V9 — Per-thread ordering for concurrent enquiries
- **Slice:** A `thread_work_queue` table (migration, see `prd/V1-PRD.md` §6) with `SELECT ... FOR UPDATE SKIP LOCKED` claims so two ticks (or two near-simultaneous webhooks for the same thread) can never double-process one thread. Postgres-only — no Redis, no new infra.
- **Demo:** fire two overlapping `/tick` calls by hand; confirm only one of them actually claims and processes any given thread's due work.
- **Done when:** a concurrency test (two claims racing for the same thread) proves exactly one wins, same style as v0's existing "concurrent `placeHold` calls: exactly one wins" test.
- **Depends on:** V7. **Size:** M.

### V10 — A free, global ceiling on Groq usage
- **Slice:** A `groq_daily_usage` table (one row per day, global, not per-tenant — every playground tenant shares one Groq API key) increments on every extraction call. Once it nears the real current ceiling for the model in use (read directly from the Groq console's Limits page before picking the number — third-party-reported figures vary and aren't trustworthy), new extractions refuse with a plain, honest message instead of letting Groq's own 429 reach a visitor raw.
- **Demo:** set the threshold artificially low in a test environment; confirm the N+1th call refuses cleanly with the honest message, not a raw provider error.
- **Done when:** there is no code path left that could produce a Groq bill without a human first adding a payment method in the Groq console by hand — this is a request ceiling, not a spend cap, because Groq's free tier cannot auto-bill.
- **Depends on:** none. **Size:** S.

*(No ticket for "move LLM wording out of the DB transaction" — already done; verified during the 2026-11-11 planning session that `handle-enquiry.ts`'s `NeedWording` pattern already fetches wording outside any open transaction. `tickets/PROGRESS.md` has been corrected.)*

---

## Phase 3 — Harden the money path

### V11 — Quote validity re-checked inside the webhook
- **Slice:** `handleWebhook` re-checks the quote's `validUntil` at the moment a `paid` event arrives, not only when a customer explicitly asks for the link again (that check already exists in `requestPaymentLink`). A payment for an already-expired quote writes a new, distinct ledger status — **held for manual review** — and does **not** flip the thread to `collected`.
- **Demo:** let a test quote expire, then deliver a signed `paid` webhook for it; the thread stays out of `collected`, and the new status is visible once `V5` exists.
- **Done when:** a still-valid quote's payment collects exactly as it does today — this ticket only adds a new branch, it doesn't touch the existing happy path (Razorpay's live proof from 2026-11-10 must keep passing unchanged).
- **Depends on:** none to build; `V5` to be visible. **Size:** S.

### V12 — Refund and failed-payment events
- **Slice:** `payment.failed` and refund webhook payloads (currently unhandled) get typed, parsed the same way `paid` already is, and write their own ledger entry type — distinct from `collected`, distinct from `payment_mismatch`. Ledger-only for v1: no owner-notification channel yet, the same stub posture escalations had before `V6` existed.
- **Demo:** deliver a signed `payment.failed` event; confirm the typed ledger entry appears and the ledger chain still verifies end to end with it present.
- **Done when:** a payment-vs-ledger reconciliation view (even a simple one, inside `V5`) can show the two ever drifting, if they do.
- **Depends on:** V5. **Size:** M.

### V13 — Stripe proven live, end to end
- **Slice:** Same recipe already proven for Razorpay on 2026-11-10: a real test-mode Stripe Payment Link, paid by hand, through a real deployed webhook, confirmed in the ledger as `collected`.
- **Demo:** `stripe listen --forward-to` the deployed webhook (or a direct Stripe webhook pointed at the live URL), pay a real test-mode link, watch the status flip.
- **Done when:** the same evidence Razorpay already has exists for Stripe — a real `providerPaymentId` in a real ledger row, not just passing unit tests.
- **Depends on:** `V1` (deploy). **Size:** S.

---

## Phase 4 — WhatsApp, whenever it's actually available

### V2 — WhatsApp Cloud API adapter, sandbox number
- **Status check first:** confirm the Meta Business Suite review has actually cleared before starting any of this — it is explicitly not gating anything in Phases 1-3.
- **Slice:** A real adapter behind the same `handleMessage` pipeline the playground already exercises — no separate pricing or wording logic. `GET` verify-token handshake; `POST` inbound message → pipeline → Cloud API send; `X-Hub-Signature-256` checked against `WHATSAPP_APP_SECRET` before anything else runs.
- **Scope, stated plainly:** this demos to up to 5 numbers manually pre-approved in Meta's dashboard — not the public. "A stranger can text this number" needs real business verification, not this ticket.
- **Account structure:** attached to a Meta Business Manager layered on Kartikay's existing personal login — never a second personal Facebook account.
- **Demo:** text the sandbox number from one of the 5 approved phones; get a real priced quote back on WhatsApp; pay the Razorpay link it sends; see it collected in the console built in Phase 1.
- **Done when:** a request with an invalid or missing signature is rejected before the pipeline is ever touched; all four fictional cards round-trip correctly from at least one sandbox number.
- **Depends on:** `V1` (deploy). **Size:** M.
- **Needs from Kartikay:** the Business Manager, the WhatsApp product attached, the sandbox number, `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_APP_SECRET`.

---

## Dependency map

```
V3a → V3b → V4 → V5 → V11(visible), V12
V3a → V3c → V4
            V4 → V6

V1 → V7 → V9
V1 → V13
V1 → V2

V10  (fully independent)
```

## Suggested order
**V3a → V3b → V3c → V4 → V5 → V6** (console, in that order — each depends on the one before it) → **V7 → V9, and V10 any time** (plumbing) → **V11 → V12 → V13** (money hardening, mostly independent of each other but all want `V5` to be visible) → **V2** whenever Meta actually clears, checked at the start of that phase, not assumed. `V1` (deploy) and `V14` (informal owner conversations, `tickets/V1-TICKETS.md`) run alongside all of it.
