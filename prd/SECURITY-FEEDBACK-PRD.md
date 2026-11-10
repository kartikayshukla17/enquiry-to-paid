# PRD: Hardening, error handling, Razorpay redirect, analytics and feedback — v1 addendum

> Status: every decision below was settled in a grilling session on 2026-11-11 (see chat log; not reproduced here). Nothing in this document is an open question — it is a build brief. Where the grilling session changed an earlier answer (screenshot storage, admin auth), only the final answer is recorded.
> Builds on `prd/PRD.md` (v0) and `tickets/V1-TICKETS.md` (v1). Does not restate decisions already final there (e.g. the agent's single-process architecture, the tenant/RLS model, the kernel/ledger contract).

---

## 1. Overview

**Feature name:** Playground hardening, feedback and analytics (v1 addendum)

**Problem statement:**
The playground (`/simulator`) and the agent it talks to are about to take real public traffic for the first time. Today: no request is rate-limited except the chat daily cap; a transient Groq blip refuses a customer immediately with no retry; every route invents its own error shape; a real Razorpay payment leaves the customer stranded on Razorpay's own success page with no way back; the playground makes no case for *why* its numbers should be trusted; nobody but Kartikay watching a terminal sees whether anyone liked it, hit a bug, or got stuck. None of this blocks a demo to one person over your shoulder. All of it blocks sending the link to a stranger.

**Proposed solution:**
Harden the request path (headers, tighter rate limits, one retry on transient LLM errors, one error shape), close the payment loop with a real redirect back to the site, add an honest trust/engagement layer to the playground, wire PostHog for funnel visibility, and give visitors a real way to report a problem (text + screenshot) that only one person — you — can read.

**AI build summary:**
> Extend the existing Next.js (Vercel) + single Node agent (Render, `agent/src/server/app.ts`) architecture. Add: Next.js security headers (report-only CSP); tightened Better Auth rate limits; a `/feedback` daily cap with upsert-not-insert semantics; one 400ms-delayed retry on transient LLM extraction errors only; a `{error:{code,message}}` envelope on every API route; a signature-verified `/simulator/paid` redirect page; a PostHog funnel (client + two server-side events); a sitewide floating feedback widget with client-side screenshot capture (html2canvas → WebP) uploaded server-side to Cloudinary; and a passwordless, single-recipient magic-link admin inbox at `/admin/feedback` (own table, not Better Auth's), emailed via Resend. No change to the kernel, the ledger, or tenant/RLS model. No new tenant-facing feature.

---

## 2. Goals & Success Metrics

**Primary goal:** Make the playground safe and legible to send to a stranger, without touching the pricing/ledger core at all.

**Success metrics:**
- Zero unhandled exceptions reach a visitor as a raw 500 or an unstyled stack trace; every failure mode returns the standard error envelope.
- A single-visitor abuse attempt (script hammering `/chat`, `/feedback`, or the magic-link request endpoint) is capped without operator intervention.
- A real Razorpay test payment redirects the customer back to a page that correctly reflects its status, 100% of documented status values.
- Kartikay can read a piece of visitor feedback, with its screenshot, from a phone, with no password to remember.

**Anti-goals:**
- Not changing how a quote is priced, refused, or ledgered.
- Not building a public analytics dashboard — PostHog is for Kartikay's own funnel visibility, not a thing visitors see.
- Not building multi-admin roles — exactly one email (`kartikay.studio@gmail.com`) can ever reach `/admin/feedback`.
- Not solving WhatsApp, Google, or the owner console — unrelated to this addendum.

---

## 3. Scope & Constraints

**In scope:** everything in the AI build summary above.

**Out of scope:** letting a visitor supply their own rate card (explicitly deferred past this addendum — see `tickets/V1-TICKETS.md`'s playground-direction note); real-money refunds/reconciliation (`V12` in v1 tickets); WhatsApp (`V2`).

**Technical constraints:**
- Platform: Next.js on Vercel + one Node process on Render, as already built. No new services beyond Cloudinary, Resend and PostHog.
- Auth: the admin inbox must share **no** table, session, or user row with Better Auth's tenant/org system.
- Data residency: PostHog Cloud **EU**. Cloudinary and Resend have no residency requirement stated (demo-scale, no customer PII transits either).
- Accessibility: the floating feedback widget and admin inbox must be keyboard-operable and screen-reader-labeled to the same bar as the rest of the site (see `DESIGN.md`).
- No secret (Cloudinary, Resend, PostHog) is ever sent to the browser; every third-party call that needs a secret happens server-side in the agent.

---

## 4. User Stories

| ID | Role | Action | Benefit |
|----|------|--------|---------|
| US1 | Visitor | am rate-limited gracefully | I never silently break the demo for others or burn Kartikay's API quota |
| US2 | Visitor | get a retried answer instead of an immediate refusal on a network blip | I see the deterministic engine actually work, not a false negative |
| US3 | Customer who paid | land back on the site after paying | I know for certain my payment went through, and can get back to my conversation |
| US4 | Visitor | see why the numbers should be trusted | I believe the determinism/safety claims instead of taking them on faith |
| US5 | Kartikay | see a funnel in PostHog | I know where visitors drop off, without reading raw ledger rows |
| US6 | Visitor | report a problem with a screenshot in one click | I don't have to describe a bug in words alone |
| US7 | Visitor who gave feedback | choose whether to be contacted | I'm not forced to hand over my email to report something |
| US8 | Kartikay | read feedback from my phone with no password | I don't need a secrets manager to check feedback |

---

## 5. Proposed Experience

**Floating feedback widget:** a single circular button, bottom-right, every page (root layout). Click opens a small panel: a textarea, a "Take screenshot" toggle (captures the current viewport client-side, shows a thumbnail, removable before sending), and Send. On success, the panel swaps to a second, smaller prompt: "Can we follow up if we have questions?" with an email field and a visible "Send anonymously" link — choosing anonymous or closing the prompt both still count the feedback as submitted (it was saved before this prompt ever appeared). Anonymous copy states plainly that a non-reversible abuse-prevention token is kept regardless.

**`/simulator/paid`:** reached only via Razorpay's own redirect. Shows one of four states keyed on `razorpay_payment_link_status`: **paid** (green, amount, a "back to this conversation" link resolved by looking up the thread via `provider_link_id` — no new query params of our own needed), **partially_paid** (amount still due, same resume link), **expired/cancelled** (a "get a new payment link" button that re-issues via the existing `requestPaymentLink` seam, no re-chat required). An invalid/unverifiable signature shows a generic "couldn't confirm this payment" state and never trusts the query string for the amount or status shown — those are re-read from our own `payments` row.

**`/admin/feedback`:** a bare request-link form ("Enter your email") -> neutral "check your inbox" response regardless of the address -> emailed link -> on click, a 30-day session -> a simple list of feedback rows (newest first), each showing text, screenshot thumbnail (click to enlarge), rating if any, email or "anonymous", timestamp. A small "Alpha" badge sits next to the page title.

**"About this demo" panel:** linked from `/simulator`, not inline in the chat. Leads with the kernel's 1,000/1,000 determinism replay result; below that, a clearly separate box labeled "real model accuracy (published, warts included)" showing the actual eval numbers (English 90.7%, Hinglish 73.2%, 2 unsafe quotes out of 88 hand-seeded cases) with a one-line note on what "unsafe" means. A single counter line: "N test enquiries run since launch" — reset to 0 the moment this goes public.

**Error states:** every API failure the visitor can cause (bad input, daily cap hit, transient LLM failure that exhausts its one retry) renders as plain, specific text — never a raw error code or stack trace. `/simulator/paid` with an unverifiable signature is the one place that must stay deliberately vague, since trusting an unverified query string would be the bug.

---

## 6. Data Models

All new tables are **not** tenant data (see `agent/src/tenancy/exempt.ts`'s existing pattern for `kill_switch_global` etc.) — they get no `tenant_id`, no RLS, and are reachable only through the agent's own trusted pool connection, never through `e2p_app`/the tenant pipeline.

```sql
-- 0017_feedback_widget.sql
-- Supersedes playground_feedback's role for the NEW floating widget; the inline thumbs widget keeps using
-- playground_feedback (0016) unchanged, since it's a different, lighter-weight signal (one rating per visitor+card).
CREATE TABLE widget_feedback (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at      timestamptz NOT NULL,
  path            text NOT NULL,                 -- which page the report was filed from
  text            text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  screenshot_url  text,                          -- Cloudinary secure_url, or NULL if no screenshot was attached
  email           text,                          -- NULL if the visitor chose "send anonymously" or closed the prompt
  ip_hash         text NOT NULL,                 -- same HMAC scheme as playground_usage; kept even when anonymous
  read_at         timestamptz                    -- set when Kartikay opens/views it in /admin/feedback
);

CREATE TABLE widget_feedback_usage (            -- the widget's own daily cap, separate from chat's
  ip_hash text NOT NULL,
  day     date NOT NULL,
  count   int  NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);

-- 0018_admin_magic_link.sql
-- Fully separate from Better Auth's user/session/organization tables by design (see Scope & Constraints).
CREATE TABLE admin_magic_links (
  token        text PRIMARY KEY,                -- random, high-entropy; never logged
  email        text NOT NULL,                   -- the address that requested it (only kartikay.studio@gmail.com is ever honoured)
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,             -- created_at + 15 minutes
  consumed_at  timestamptz                       -- set on first (and only) successful click
);

CREATE TABLE admin_sessions (
  token      text PRIMARY KEY,                   -- the session cookie's value
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL                -- created_at + 30 days
);

CREATE TABLE admin_link_requests (               -- rate limit for the "send me a link" endpoint
  ip_hash   text NOT NULL,
  window_at timestamptz NOT NULL,                -- truncated to the 5-minute bucket
  count     int NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_at)
);
```

**Ledger provenance addition (no new table):** a successful-on-retry extraction appends `retried: true` to the existing `extraction`/`quote` ledger payload (via `appendEntry`, same as every other provenance field already recorded).

---

## 7. API / Integration Surface

All responses below use the standardized envelope on failure: `{ "error": { "code": string, "message": string } }`. Success shapes are unchanged from what each route already returns today, except where noted.

| Method | Path | Description | Rate limit |
|--------|------|-------------|------------|
| POST | `/chat` (agent) | unchanged pipeline call; now retries one transient extraction failure (400ms delay) before refusing | existing 30/day/visitor |
| POST | `/feedback` (agent) | unchanged (inline thumbs); now upserts latest-per-visitor-per-card | new: 10/day/visitor |
| POST | `/widget-feedback` (agent, new) | `{ path, text, screenshotDataUrl? }` -> uploads screenshot server-side to Cloudinary if present, inserts `widget_feedback`, returns `{ id }` | 10/day/visitor (`widget_feedback_usage`) |
| PATCH | `/widget-feedback/:id` (agent, new) | `{ email? }` — the second-step contact-info update; absent/omitted = anonymous | none beyond the row's own existence |
| GET | `/simulator/paid` data route (Next, new) | verifies `razorpay_signature` server-side against `key_secret`, looks up the `payments` row by `razorpay_payment_link_id`, returns status + amount + thread lookup for the resume link | none (read-only, signature-gated) |
| POST | `/payments/:paymentId/reissue` (agent, new) | re-issues a payment link for an expired/cancelled quote via the existing `requestPaymentLink` seam | existing kill-switch/validity checks apply unchanged |
| POST | `/admin/request-link` (agent, new) | `{ email }` -> always `{ ok: true, message: "If that email is registered, a link is on its way." }` regardless of match; only sends an email via Resend when `email === "kartikay.studio@gmail.com"` | 1/5min/IP (`admin_link_requests`) |
| GET | `/admin/verify?token=...` (agent, new) | consumes a magic-link token once, sets the 30-day session cookie, redirects to `/admin/feedback` | token itself is the rate limit (15-min expiry, single use) |
| GET | `/admin/feedback` (agent, new) | requires the session cookie; lists `widget_feedback` newest-first | session-gated |

**External integrations:**
- **Cloudinary** — server-side authenticated upload (never an unsigned client preset) of the WebP screenshot; 90-day auto-expiry set on upload.
- **Resend** — transactional send of the magic-link email; single template, single recipient address in practice.
- **PostHog** (Cloud, EU) — `posthog-js` client-side for page views and UI events; `posthog-node` server-side from the agent for `quote_issued` and `payment_collected`.

---

## 8. Acceptance Criteria

**US1 — Graceful rate limiting**
- [ ] Better Auth's limiter is explicitly forced on regardless of Render's `NODE_ENV`; global default tightened to 20 req/10s.
- [ ] `/feedback` and `/widget-feedback` each refuse a 31st-in-a-day request from the same visitor-IP-hash with a typed `{error:{code:"daily_cap",...}}`, never a raw 500.
- [ ] A rating resubmitted for the same visitor+card **updates** the existing row; `playground_feedback` never accumulates duplicates for one visitor+card pair.

**US2 — Retry before refusing**
- [ ] A `timeout`/`rate_limited`/`http_error` on extraction retries exactly once, 400ms later, before falling back to the existing holding-reply refusal.
- [ ] A schema-validation failure (not a transport error) never retries.
- [ ] A successful retry's ledger row carries `retried: true`; a first-try success never does.

**US3 — Razorpay redirect**
- [ ] A real test payment redirects to `/simulator/paid` with a verified signature.
- [ ] Each of `paid`, `partially_paid`, `expired`, `cancelled` renders its own correct message and action.
- [ ] The amount and status shown always come from our own `payments` row, never directly from the unverified query string.
- [ ] "Back to this conversation" correctly reopens the same thread's card and customerRef in `/simulator`.
- [ ] Reissuing a link for an expired/cancelled payment produces a new, valid Razorpay link without requiring a new chat message.

**US4 — Trust panel**
- [ ] The determinism stat shown matches the kernel's actual current test count (1,000, per `kernel/tests/evaluate.rs`) — this number is read from the same source the test asserts, not hand-typed twice.
- [ ] The eval accuracy numbers shown match the latest published `RESULTS.md`/eval output exactly, including the unsafe-quote count.
- [ ] The visitor counter is labeled "test enquiries run," never "customers" or "users served."

**US5 — PostHog funnel**
- [ ] `playground_opened`, `enquiry_sent`, `quote_received`, `link_clicked` fire client-side; `quote_issued` and `payment_collected` fire server-side from the agent.
- [ ] No event payload contains a raw phone number, email, or other customer PII.

**US6/US7 — Widget feedback**
- [ ] "Take screenshot" captures the current viewport with no browser permission prompt.
- [ ] The captured image is converted to WebP client-side before upload.
- [ ] The Cloudinary upload happens server-side only; no Cloudinary credential ever appears in a browser request.
- [ ] Submitting without a screenshot is accepted (screenshot is optional, not required).
- [ ] The contact-info prompt appears only after the first submission already returned success.
- [ ] Choosing "send anonymously" (or abandoning the prompt) stores `email = NULL`; the row still exists with its text/screenshot.
- [ ] The anonymous-choice copy explicitly states the IP hash is still kept.

**US8 — Admin inbox**
- [ ] `/admin/request-link` returns the identical response body/status whether or not the submitted email matches the allowed address.
- [ ] An email is actually sent via Resend only when the address matches `kartikay.studio@gmail.com`.
- [ ] A magic-link token is single-use: a second click on the same link fails.
- [ ] A token unused for 15 minutes can no longer be consumed.
- [ ] The session cookie remains valid for 30 days and is rejected after that.
- [ ] `/admin/feedback` is unreachable without a valid session (no bypass via a direct API call).
- [ ] The UI visibly labels this feature "Alpha."

---

## 9. Open Questions & Risks

- **Risk:** Render's free-tier cold start delays the very first webhook/redirect after idle. *Mitigation:* already documented in `docs/DEPLOY.md`; providers retry.
- **Risk:** Cloudinary's free tier has hard caps even with 90-day expiry if feedback volume spikes unexpectedly (e.g. a viral post). *Mitigation:* the daily per-visitor cap on `/widget-feedback` already bounds worst-case volume; revisit if the playground itself goes viral.
- **Risk:** Resend's shared/dev sending domain may affect deliverability to a Gmail address long-term. *Mitigation:* single recipient, low volume; verify a sending domain only if delivery problems actually appear.
- **Q:** should `admin_sessions`/`admin_magic_links` rows ever be pruned (they grow forever otherwise, slowly)? *Owner: Kartikay, low priority — rows are tiny and infrequent.*

---

## 10. Rollout & Next Steps

**Order (matches the sequencing already agreed with Kartikay):**
1. Headers/CSP (report-only) → tightened rate limits, debounce guards, LLM retry, standardized error envelope.
2. Razorpay redirect (`/simulator/paid`, reissue endpoint).
3. PostHog wiring (client + two server events).
4. New feedback widget (screenshot capture, Cloudinary upload, two-step contact prompt).
5. Admin inbox (magic link, Resend, `/admin/feedback`).

**Sign-off needed from:** Kartikay only (solo project; decisions already final per the grilling session this PRD records).

**Next steps:**
1. Build in the order above, test-first, one focused commit per numbered phase — *Owner: Claude, starting immediately.*
2. Kartikay creates the Cloudinary account and supplies its credentials before phase 4 begins.
3. A Resend account/API key is needed before phase 5 begins.
