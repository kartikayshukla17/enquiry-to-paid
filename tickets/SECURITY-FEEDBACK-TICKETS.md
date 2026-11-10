# Tickets: hardening, Razorpay redirect, analytics, feedback

Derived from `prd/SECURITY-FEEDBACK-PRD.md`. Same rules as every other ticket file in this repo: every ticket is a **vertical slice** that cuts through every layer it needs and ends in something you can run and watch — never "add a table" or "add a library" on its own. No ticket here touches the kernel, the ledger contract, or the tenant/RLS model.

**Sizes:** S ~1 day, M ~2-3 days, L ~4-5 days.

---

## Phase S-A — Request-path hardening

### S1 — Security headers on the Vercel site (report-only CSP)
- **Slice:** `next.config.ts` `headers()` sets X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and a `Content-Security-Policy-Report-Only` (not enforced yet) across every route.
- **Demo:** `curl -sI https://<vercel-url>/` shows all the headers; browser devtools console shows CSP violation *reports* only, nothing broken.
- **Done when:** a few days of real traffic show zero unexpected violations, then the header is flipped from Report-Only to enforced in a follow-up one-line change (tracked here, not a separate ticket).
- **Depends on:** none. **Size:** S.

### S2 — Tighten rate limits: Better Auth + a real `/feedback` cap
- **Slice:** Force Better Auth's limiter on in production regardless of Render's `NODE_ENV`; tighten its global default to 20 req/10s. Give `/feedback` its own 10/day-per-visitor cap (reusing the existing IP-hash helper), and change its insert to an upsert keyed on visitor+card (latest rating replaces, never accumulates).
- **Demo:** 21 rapid auth requests from one IP get a 429 with `X-Retry-After`; the 11th `/feedback` call in a day from one visitor refuses; rating the same card twice from one visitor leaves exactly one row.
- **Done when:** a test proves the upsert (two ratings, one row) and the cap (11th call refused).
- **Depends on:** none. **Size:** S.

### S3 — Debounce the feedback buttons
- **Slice:** The 👍/👎 buttons disable themselves the instant they're clicked (before the request resolves), same pattern chat's Send button already uses.
- **Demo:** double-click 👎 on the simulator page; exactly one request fires, visible in the network tab.
- **Done when:** a component test or manual check shows no second request fires before the first resolves.
- **Depends on:** none. **Size:** S.

### S4 — One retry on a transient LLM extraction failure
- **Slice:** In the extraction path only (never word-reply, never on a schema-validation failure), a `timeout`/`rate_limited`/`http_error` retries exactly once after a 400ms delay before falling back to today's refusal. A successful retry appends `retried: true` to the ledger payload.
- **Demo:** inject a provider stub that fails once then succeeds; the enquiry still gets a quote, and the ledger row shows `retried: true`. A stub that fails twice still refuses, same as today.
- **Done when:** both cases are covered by a test; a schema failure (not a transport error) is proven to never retry.
- **Depends on:** none. **Size:** S.

### S5 — Standardized `{error:{code,message}}` envelope, everywhere
- **Slice:** Every API route (`/chat`, `/feedback`, `/payment-status`, `/webhooks/payments/:provider`, auth) returns errors in one shape. The three frontend call sites that read `j.error` as a plain string are updated in the same change.
- **Demo:** trigger one failure per route (bad body, daily cap, unsigned webhook) and show the identical shape in each response; the simulator page still shows the right message text.
- **Done when:** every route's error path is covered by at least one test asserting the new shape; no route still returns a bare string.
- **Depends on:** S2, S4 (touches the same error paths they just added). **Size:** M.

---

## Phase S-B — Razorpay redirect

### S6 — `/simulator/paid`: verified redirect landing page
- **Slice:** Razorpay's Payment Links get `callback_url` + `callback_method: "get"` pointed at this new page. It verifies `razorpay_signature` server-side, looks up the real `payments` row by `razorpay_payment_link_id` (never trusts the query string for amount/status), and renders one of four states: paid, partially_paid, expired, cancelled.
- **Demo:** pay a real test-mode link; land on a page showing the correct amount and "paid," sourced from our own row, not the URL.
- **Done when:** a forged/tampered query string fails signature verification and shows the generic "couldn't confirm this payment" state, never a fabricated success.
- **Depends on:** S5 (uses the new error envelope for the failure state). **Size:** M.

### S7 — Resume-thread and reissue-link actions
- **Slice:** The paid page's "back to this conversation" link resolves the thread (via the payment row already looked up in S6) and reopens the same card+customerRef in `/simulator`. The expired/cancelled state gets a "get a new link" button calling a new `POST /payments/:paymentId/reissue` endpoint (wraps the existing `requestPaymentLink` seam).
- **Demo:** let a test link expire, click "get a new link," pay the new one, land back on S6's page showing paid.
- **Done when:** reissue respects the same kill-switch/validity checks `requestPaymentLink` already enforces; a collected thread cannot be reissued.
- **Depends on:** S6. **Size:** S.

---

## Phase S-C — Analytics

### S8 — PostHog client-side (page views + UI funnel)
- **Slice:** `posthog-js` wired into the Next.js site (EU region), firing `playground_opened`, `enquiry_sent`, `quote_received`, `link_clicked` on the existing simulator interactions.
- **Demo:** open PostHog's live events view, run a sample enquiry through to a payment link, watch the four events land in order.
- **Done when:** no event payload contains a phone number, email, or other PII (checked by hand against one real capture).
- **Depends on:** none. **Size:** S.

### S9 — PostHog server-side funnel completion
- **Slice:** `posthog-node` in the agent fires `quote_issued` (on a quote outcome) and `payment_collected` (from the webhook handler, on a real `collected` transition).
- **Demo:** pay a real test link; `payment_collected` appears in PostHog with no action needed from the browser.
- **Done when:** the funnel in PostHog shows a believable drop-off shape end to end, client and server events in one timeline.
- **Depends on:** S8, S7 (reuses the webhook/payment-status plumbing S6/S7 touched). **Size:** S.

### S10 — "About this demo" trust panel
- **Slice:** A page linked from `/simulator` leading with the kernel's determinism result (read from the same figure `kernel/tests/evaluate.rs` asserts, not hand-typed twice), a clearly separate box with the real, current eval accuracy numbers (warts included), and a counter ("N test enquiries run since launch").
- **Demo:** open the panel, see both numbers match the latest test/eval output exactly.
- **Done when:** the counter is labeled "test enquiries run" (never "customers"), and resets to zero only at actual public launch (a one-line flag flip, not built as a recurring job).
- **Depends on:** none. **Size:** S.

---

## Phase S-D — The new feedback widget

### S11 — Floating widget: sitewide, text-only submission
- **Slice:** A bottom-right button in the root layout, every page. Opens a panel: textarea + Send. Posts `{ path, text }` to a new `/widget-feedback` endpoint, inserting into the new `widget_feedback` table. Button disables itself on click (same guard as S3).
- **Demo:** submit from any page; `SELECT * FROM widget_feedback` shows the row with the right `path`.
- **Done when:** this coexists with the inline 👍/👎 widget untouched — neither replaces the other.
- **Depends on:** S5 (error envelope). **Size:** S.

### S12 — Screenshot capture
- **Slice:** "Take screenshot" captures the current viewport client-side (DOM rasterization, no permission prompt), converts it to WebP, shows a removable thumbnail before sending.
- **Demo:** click the toggle, see a thumbnail of the actual visible page, remove it, re-add it, send.
- **Done when:** no browser permission dialog ever appears; the captured image is WebP before it leaves the browser.
- **Depends on:** S11. **Size:** M.

### S13 — Server-side Cloudinary upload
- **Slice:** The screenshot (if present) uploads server-side from the agent to Cloudinary (never an unsigned client preset, never a credential sent to the browser), with a 90-day auto-expiry set on upload; `widget_feedback.screenshot_url` stores the resulting `secure_url`.
- **Demo:** submit with a screenshot; the row's `screenshot_url` opens a real Cloudinary-hosted image.
- **Done when:** a submission with no screenshot leaves `screenshot_url` null without erroring.
- **Depends on:** S12; **needs Kartikay's Cloudinary credentials in `agent/.env` first.** **Size:** S.

### S14 — Two-step contact prompt
- **Slice:** On a successful submission, the panel swaps to a second prompt: email field + "send anonymously." `PATCH /widget-feedback/:id` sets the email, or leaves it null. Anonymous copy states plainly that the IP hash is still kept.
- **Demo:** submit, see the second prompt, pick anonymous; the row has no email but the submission already succeeded (closing the prompt does not delete it). Submit again, give an email this time; the row has it.
- **Done when:** a malformed email (no `@`, no `.`) is rejected with a clear message; the prompt never blocks or re-asks for the original text.
- **Depends on:** S13. **Size:** S.

---

## Phase S-E — Admin inbox

### S15 — Magic-link request + send (Resend)
- **Slice:** `POST /admin/request-link` always returns the same neutral response; sends a real email via Resend only when the address is `kartikay.studio@gmail.com`. Own table (`admin_magic_links`), 15-minute expiry, rate-limited 1/5min/IP (`admin_link_requests`).
- **Demo:** request a link with the right email, receive it in the inbox within seconds; request with any other email, get the identical response and no email sent.
- **Done when:** 6 rapid requests from one IP get the 6th refused.
- **Depends on:** S5. **Size:** M.

### S16 — Magic-link verify, session, and the feedback list
- **Slice:** `GET /admin/verify?token=...` consumes the token once, sets a 30-day session cookie, redirects to `/admin/feedback`, which lists `widget_feedback` newest-first (text, screenshot thumbnail, rating if any, email or "anonymous", timestamp) behind the session. Page carries a visible "Alpha" badge.
- **Demo:** click a real emailed link, land on a populated feedback list; click the same link again and it fails (already consumed); wait past 15 minutes and an unused link fails the same way.
- **Done when:** hitting `/admin/feedback` directly with no session redirects to the request-link form, never shows data.
- **Depends on:** S15, S14 (there must be rows to show). **Size:** M.

---

## Dependency map

```
S1, S3, S8, S10            (fully independent, any order)
S2 → S4 → S5 → S6 → S7 → S9
                 S5 → S11 → S12 → S13 → S14 → S16
                 S5 → S15 → S16
```

## Suggested order

Matches the PRD's rollout order: **S1-S5** (hardening) → **S6-S7** (Razorpay redirect) → **S8-S9** (PostHog) → **S10** (trust panel, can slot in anywhere after S5) → **S11-S14** (widget; S13 blocks on Kartikay's Cloudinary credentials) → **S15-S16** (admin inbox; needs a Resend API key before S15).
