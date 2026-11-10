# v1 tickets: demo-grade, real-channel, real-money product

Companion to `TICKETS.md` (v0, T0-T14) and `UI-TICKETS.md` (owner console). v1 has no committed pilot customer, so scope is set against a different bar than the PRD's "Paid (revenue share live)" stage: **a single tenant, run by Kartikay, that a stranger can actually use over real WhatsApp and really pay, hosted somewhere other than a laptop.** Full pilot compliance (T29) stays deferred until a real owner commits.

**Revised 2026-11-11 after a grilling session** that resequenced this whole file: WhatsApp moved from leading the plan to trailing it (it's the least controllable piece, blocked twice by Meta so far), the owner console and production plumbing became the actual spine, and two tickets (V7-V10) were redesigned around a hard constraint found during the session — Render's free tier has no background-worker option at all, confirmed by Render's own staff.

**Rules carried over:** every ticket is a vertical slice ending in something runnable. All data stays fictional/labelled except the infrastructure itself (a real Meta number, a real Render/Vercel deploy, real test-mode payment rails). Nothing here costs money by design — see V10.

**Sizes:** S ~1 day, M ~2-3 days, L ~4-5 days.

---

## Phase V1-A — Owner console
(Same tickets as `UI-TICKETS.md`, reordered for v1 velocity. This is the spine of v1, not WhatsApp.)

### V3 = U0+U1+U2 — Real sign-up, tenant-scoped API, app shell
- **Slice:** A genuine self-serve "create your business" flow (not a hardcoded pre-seeded tenant — this should demo well to someone other than Kartikay), org creation mapping to a tenant, `withTenant`-backed `/api/app/*`, and the nav shell. Auth pages already exist (`/login`, `/account`).
- **Scope decision:** build only the **owner** role path for v1. There is exactly one real operator today; staff/manager restriction-testing waits until an actual second person needs access.
- **Phone numbers:** staff (when that role exists) see a **masked** number (last 2-3 digits visible), never the full number and never nothing at all.
- **Depends on:** none (auth already built). **Size:** M.

### V4 = U3 — Inbox and thread detail
Unchanged from `UI-TICKETS.md`.

### V5 = U4 — Quote and ledger viewer with the chain-verify badge
Unchanged. Also the landing spot for V11/V12's "held for review" and refund/failure events below — no separate notification UI needed for v1.

### V6 = U5 — Escalation queue with takeover and handback
- **Decision:** build this **now**, against the playground's own real escalations (the simulator already generates genuine ones — a discount request, an out-of-coverage enquiry). It doesn't need a live phone to be real, and "human-in-the-loop safety" is a stronger, rarer demo story than a plain inbox. Does not wait for V2 (WhatsApp).

**Dropped from v1 entirely:** U6 (in-app rate-card compile/approve/activate UI). Cards are only ever edited by Kartikay, directly, as JSON, in this repo — there is no audience for an editor UI yet. Revisit only when either a real pilot owner who isn't comfortable editing JSON exists, or Sheets-as-source (T22) gets built instead.

---

## Phase V1-B — Production plumbing
Redesigned around a confirmed constraint: **Render's free web-service tier cannot run a background worker, a private service, or a cron job** — Render's own staff have confirmed this on their community forum; all three require a paid instance starting at $7/month. Rather than pay for that, v1 stays genuinely free.

### V7 — A "tick" endpoint on the existing web service, triggered by GitHub Actions
- **Slice:** Hold expiry, chaser sends and the owner digest move from `pnpm sim tick` to a `POST /tick` endpoint on the already-deployed agent. A scheduled GitHub Actions workflow (reusing the CI infrastructure this repo already has — no new third-party cron account) hits it every **5 minutes**.
- **Demo:** disable the workflow, place a hold, confirm it does not expire on schedule; re-enable it, confirm it does within one tick.
- **Known tradeoff:** this bundles background work onto the same process serving visitor requests, and depends on GitHub Actions' own scheduler actually firing (not instant/guaranteed-to-the-second, same caveat as any cron). Acceptable for a free, demo-stage service; revisit if real traffic ever needs true always-on reliability.
- **Depends on:** V1 (the agent must be deployed for GitHub Actions to reach it). **Size:** M.

### V8 — ~~Move LLM wording out of the DB transaction~~ (already done, no ticket needed)
Found during the grilling session: `handle-enquiry.ts`'s `NeedWording`/retry pattern already fetches wording with the transaction rolled back and no transaction open — verified directly in the code (the only `deps.worder` call site is outside any `withTenant` callback). The "known gap" note in `tickets/PROGRESS.md` was stale; corrected there. Nothing to build here.

### V9 — Per-thread ordering for concurrent enquiries
- **Slice:** A lightweight Postgres-only ordering guarantee (no Redis, no new infra — `SELECT ... FOR UPDATE SKIP LOCKED` or equivalent) so two messages in the same thread arriving close together process in order rather than racing. Pairs naturally with V7's tick endpoint, which already needs to claim work safely.
- **Depends on:** V7. **Size:** M.

### V10 — A free, global ceiling on Groq usage (not a dollar spend cap)
- **Slice:** Groq's free tier needs no card and never auto-bills — upgrading to paid is a deliberate, separate step nobody is taking. So there is no dollar amount to cap; the real risk is Groq's own free-tier rate/request ceiling (shared across every playground tenant, since they all use one API key) getting hit and returning a raw, confusing 429 straight to a visitor. A **global** (not per-tenant) daily counter refuses new extractions with a plain, honest message ("today's AI quota is used up, try again tomorrow") once usage nears — not exceeds — Groq's actual published ceiling for the model in use. Read the real current numbers from the Groq console's own Limits page before picking the exact threshold; third-party-reported figures vary and shouldn't be trusted blindly.
- **Done when:** this service can never produce a Groq bill without someone deliberately adding a card in the Groq console first.
- **Depends on:** none. **Size:** S.

---

## Phase V1-C — Harden the money path

### V11 — Quote validity re-checked inside the webhook, not just on re-ask
- **Slice:** Today `requestPaymentLink` checks `validUntil` only when a customer explicitly asks for the link again; the webhook itself doesn't re-check at the moment of collection. Close that gap.
- **Decision:** a payment arriving for an already-expired quote is **held for manual review**, never auto-honored at the old (possibly stale) price. Surfaces in V5's ledger viewer once that's built; no separate notification channel for v1.
- **Depends on:** V5 (for visibility; the check itself doesn't). **Size:** S.

### V12 — Refund and failed-payment events; reconciliation
- **Slice:** `payment.failed` / refund webhooks currently have no handling path; add typed ledger events and a way to see payment-vs-ledger drift.
- **Decision:** ledger-only for v1 — visible once V5 exists, same as V11. No owner-notification channel built for this yet (matches how escalations already work as a stub before V6).
- **Depends on:** V5. **Size:** M.

### V13 — Stripe proven live end-to-end
Razorpay was paid for real on 2026-11-10 (test mode, confirmed webhook -> collected). Stripe's adapter has equivalent tests but has never taken a real test payment through `stripe listen` / a deployed endpoint. Prove it the same way.

---

## Phase V1-D — Real channel, whenever it's actually available

### V1 — Deploy: agent on Render, site on Vercel (code ready 2026-11-11; deploy pending)
Unchanged from before — see `docs/DEPLOY.md`. This is **not** blocked by anything below and can happen any time; it's listed here only because its number predates the resequencing.

### V2 — WhatsApp Cloud API adapter, sandbox number (T25, scoped) — deprioritized
- **Status (2026-11-11):** Meta's business-verification review is pending (separate from a routine device-login security hold on Kartikay's personal Facebook account, which is expected to clear on its own and needs no account changes). **Decision:** do not lead the plan with this. Blocked twice already by forces outside this project's control; slot it in opportunistically whenever Meta clears, after V1-A/B/C are done.
- **Scope correction:** a WhatsApp *sandbox* can only message up to 5 numbers manually pre-approved in Meta's dashboard — never a stranger off the street. V2's actual goal is **a controlled demo video on a known phone**, not "a public WhatsApp number anyone can text." That second thing only becomes possible after real business verification clears.
- **Account structure, once unblocked:** not a second personal Facebook account (still inadvisable — see chat log 2026-11-11 for the full reasoning). The correct, sanctioned path is a **Meta Business Suite / Business Manager**, a business entity layered on top of Kartikay's one real personal login, with the WhatsApp product attached to that Business Manager rather than the personal profile directly.
- **Slice (once started):** real adapter behind the same `handleMessage` pipeline the simulator already uses: GET verify-token handshake, POST inbound message -> pipeline -> Cloud API send, `X-Hub-Signature-256` check against `WHATSAPP_APP_SECRET`.
- **Demo:** text the sandbox number from a phone; get a real priced quote back on WhatsApp; pay the Razorpay link it sends; see it collected.
- **Depends on:** V1 (deploy). **Size:** M.
- **Needs from Kartikay:** the Business Manager set up, WhatsApp product added, sandbox test number, `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_APP_SECRET`.

---

## Ongoing, non-blocking

### V14 — Informal owner conversations
Not a formal T27 interview — any real person who quotes customers by hand (real-estate contacts are the nearest lead). Cheap signal on wording and pricing assumptions before investing further in V1-A/B.

---

## Suggested order
**V3-V6** (owner console — fully within our control, the spine of v1) -> **V7-V10** (plumbing, all free-tier-safe by design) -> **V11-V13** (money hardening) -> **V2** (WhatsApp, whenever Meta clears — not gating anything above it) -> **V14** alongside all of it, whenever a conversation is available. V1 (deploy) can and should happen any time; it isn't gated by this reordering.

## Explicitly out of v1
T20 (voice), T21-T24 (Google Calendar/Sheets/Docs), T26 (React Router v8), full T29 pilot compliance (DR plan, access audit, independent security review), UI tickets U6 (dropped, see Phase V1-A), U7-U11 (payments view, settings, audit export, marketing truth pass).
