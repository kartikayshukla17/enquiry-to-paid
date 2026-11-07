# Credential setup guide

Written from memory of each vendor's dashboard. Menu names move around; where a step says "check the label", trust the screen over this page. **Never commit a secret.** Everything below goes in `agent/.env` (gitignored). A template with no values is in `agent/.env.example`.

Everything in this repo is fictional test data. Use test/sandbox modes only until the pilot checklist (T29) is done.

---

## 1. Supabase (test project, Singapore)

Test project is in `ap-southeast-1` (Singapore) on purpose. The PRD's production target is Mumbai (`ap-south-1`); recreate the project there before any real customer data. Nothing here is Supabase-specific, so the move is a dump and restore.

1. Project dashboard → **Connect** → copy the **session pooler** string (port 5432) and put it in `DATABASE_URL`. Replace `[YOUR-PASSWORD]` with the database password you set at project creation (reset it under Settings → Database if lost).
2. Why 5432 and not the 6543 transaction pooler: the app uses `pg` and `SET LOCAL` per transaction, plus durable timers and migrations. `SET LOCAL` is transaction-scoped so 6543 also works, but 5432 avoids surprises with advisory locks and DDL.
3. The Supabase quickstart shows `postgres-js` with `prepare: false`. We use `pg` (node-postgres), which does not prepare named statements by default, so that flag does not apply. Do not add Prisma; there is no Prisma in this repo.
4. Settings → API → **disable the Data API** (PostgREST). A test asserts the Data API is unreachable.
5. Do not use Supabase Auth. Auth is Better Auth on this database.
6. `DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`

Local development keeps using the Docker Postgres on port 54329.

---

## 2. Google (OAuth consent screen, scopes, client)

You already have a project and a Web client. Menu: **Google Auth Platform** (older UI: APIs & Services → OAuth consent screen).

### 2.1 Branding
App name, user support email, developer contact email. Logo, homepage and privacy-policy URL are optional while in Testing and required to publish.

### 2.2 Audience
- **External**, publishing status **Testing**.
- Add your own Gmail and any tester accounts under **Test users** (max 100).
- Testing-mode catch: refresh tokens for External apps in Testing expire after 7 days. Fine for development, not for a pilot. Plan Google verification before the pilot.

### 2.3 Data access (scopes)
Add only what a ticket needs. The picker lists many scopes that look like "email". They are not the same thing:

| What you see | What it is | Add it? |
|---|---|---|
| `.../auth/userinfo.email` | Your Google account's email address (sign-in) | **Yes** |
| `.../auth/userinfo.profile` | Name and picture (sign-in) | **Yes** |
| `openid` | OpenID Connect sign-in | **Yes** |
| `.../auth/gmail.*` (readonly, send, modify, compose, metadata...) | Access to the user's actual Gmail mailbox | **No.** Restricted scopes need a paid security assessment and nothing in this product reads or sends email. |

Those three are non-sensitive and need no Google review.

For T21 to T24 (later), prefer the narrowest scope that works. Check the sensitivity label shown next to each scope in the picker, it decides whether verification is needed:

| Ticket | Need | Prefer | Avoid |
|---|---|---|---|
| T21 Calendar availability and holds | read free/busy, create/delete tentative events | `calendar.freebusy` + `calendar.events` (or `calendar.app.created` to touch only calendars the app created) | `calendar` (full access) |
| T22 Sheets as rate-card source | read the owner's rate-card sheet | `drive.file` (only files the owner picks via the Google Picker or that the app created) | `drive` (restricted, all files) |
| T23 Sheets ledger mirror | append rows to a sheet the app created | `drive.file` + `spreadsheets` only if a plain Sheets API write needs it | |
| T24 Docs to PDF | merge a template, export PDF | `drive.file` + `documents` | `drive` |

`drive.file` is the key to staying out of the restricted tier. It means the T22 flow must have the owner pick the sheet (Picker) rather than the app listing their Drive.

### 2.4 APIs to enable
APIs & Services → Library: Google Calendar API, Google Sheets API, Google Drive API, Google Docs API. (You have already turned these on.) Gmail API: leave off.

### 2.5 The OAuth client (Credentials → your Web client)
- **Authorized JavaScript origins:** `http://localhost:3000`, plus your tunnel URL while testing webhooks, plus the production and staging origins later.
- **Authorized redirect URIs:** `http://localhost:3000/api/auth/callback/google` (Better Auth default), the production equivalent, and later one for the per-tenant Calendar connection (whatever callback route T21 ships).
- Matches are exact: scheme, host, port, trailing slash. `http` only works for `localhost`.

### 2.6 Env
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Rotate the secret if it has ever been pasted into a chat or committed.

### 2.7 Better Auth (not wired yet)
`agent/src/auth/index.ts` has `baseURL` but no `socialProviders` or `trustedOrigins`. When Google sign-in is added, set `baseURL` and `trustedOrigins` to the same origins as 2.5, read from env.

---

## 3. Razorpay (India, test mode)

1. Dashboard → toggle **Test Mode** (top bar). Everything below is test data.
2. **Account & Settings → API Keys → Generate Test Key.** You get a Key Id (`rzp_test_...`) and a Key Secret. The secret is shown once; store it immediately.
3. **Payment links:** the agent creates them through the Payment Links API (`POST /v1/payment_links`). They can also be made by hand under Payments → Payment Links for a quick look. Amounts are in **paise** (integer minor units, same as the kernel).
4. **Webhook:** Account & Settings → **Webhooks → Add new webhook**.
   - URL: your public endpoint (a tunnel while developing, e.g. ngrok or cloudflared; localhost is not reachable).
   - Secret: choose a long random string. This is `RAZORPAY_WEBHOOK_SECRET`. It is not the API key secret.
   - Events: `payment_link.paid`, `payment.captured`, `payment.failed`.
   - Razorpay signs the raw request body with HMAC-SHA256 using that secret and sends it in the `X-Razorpay-Signature` header. The adapter must verify against the **raw** bytes before parsing.
5. **Test payments:** card `4111 1111 1111 1111`, any future expiry, any CVV, any OTP; UPI `success@razorpay` (success) and `failure@razorpay` (failure). Check Razorpay's current test-data page, these can change.
6. Env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
7. Live mode later needs KYC (PAN, bank account, business details). Not before the pilot.

The repo's `RazorpayPaymentLinkSim` is a simulated adapter with the same signature scheme. The real adapter and an HTTP webhook route are not built yet; those variable names are the ones to use when they are.

---

## 4. Stripe (test mode)

1. Dashboard → stay in **Test mode** (toggle top right, or a "Test mode" banner).
2. **Developers → API keys.** Use a **restricted key** (`rk_test_...`) limited to what the adapter needs (Payment Links, Products/Prices, Checkout Sessions: write; Events: read) rather than the full secret key. A full secret key (`sk_test_...`) also works for development.
3. **Payment Links:** create through the API (`POST /v1/payment_links`) with a price. Amounts are in the smallest currency unit. Put the thread/job ID in `metadata` so the webhook can map a payment back to a ledger thread.
4. **Webhook, local:** install the Stripe CLI, `stripe login`, then `stripe listen --forward-to localhost:<port>/<webhook-route>`. It prints a signing secret `whsec_...` for that session. That is `STRIPE_WEBHOOK_SECRET` locally.
5. **Webhook, deployed:** Developers → Webhooks → Add endpoint, your URL, events `checkout.session.completed` and `payment_intent.payment_failed`. It shows its own `whsec_...`.
6. Signature: the `Stripe-Signature` header carries a timestamp and signature (`t=...,v1=...`) over the raw body. Verify with the SDK helper or manually, and reject timestamps outside a tolerance. The simulated adapter already models the timestamp tolerance.
7. **Test cards:** `4242 4242 4242 4242` (success), `4000 0000 0000 9995` (declined, insufficient funds). Any future expiry, any CVC. Check Stripe's current testing page.
8. Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
9. Stripe's availability for businesses registered in India is limited. Confirm eligibility before building the pilot on it; the product's per-tenant provider selection exists for exactly this reason.

---

## 5. Meta WhatsApp Cloud API (T25, not yet)
Business verification takes about a day or more. Sandbox first: developers.facebook.com → app → add WhatsApp → test number and temporary token for up to 5 recipient numbers. Production needs a verified business, a real number not already on WhatsApp, a permanent system-user token, approved message templates and a webhook with a verify token. A private compliance review is required first. Env: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`.

---

## 6. Other local secrets
`openssl rand -base64 32` for each of `PII_ENC_KEY`, `PHONE_HASH_KEY`, `BETTER_AUTH_SECRET`. Losing `PII_ENC_KEY` makes stored PII unreadable. In production these live in a secrets manager, not in `.env`.

Groq: console → API Keys. The code's default model is not available on every account; set `GROQ_MODEL` (we used `openai/gpt-oss-120b`). Live mode refuses a model until it passes the T9 gate.

---

## 7. Public URLs, in one place
Webhooks cannot reach localhost. While testing, run a tunnel and use its HTTPS URL for: Razorpay webhook, Stripe webhook (or use `stripe listen`), Meta callback URL, and as an extra Google origin if you test OAuth through it. Update every list when the tunnel URL changes.
