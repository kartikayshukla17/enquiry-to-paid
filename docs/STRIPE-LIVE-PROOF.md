# Stripe proven live, end to end (V13): the owner's checklist

This is the one manual act V13 could not perform in that session: a real test-mode Stripe Payment Link,
paid by hand, through the real deployed webhook, confirmed `collected` in the ledger with a real
`providerPaymentId` — the same evidence Razorpay already has. Everything up to this point (the adapter, its
tests, the webhook route, the docs) is already built and audited; this page is only the sequence of manual
steps left, in order, for whoever has dashboard access once the agent is actually deployed (V1).

Follow it top to bottom. Every placeholder below is explicit; nothing here needs you to guess a URL shape or
an internal id.

## 0. Prerequisites

- V1 is done: the agent is live on Render and the site is live on Vercel, per `docs/DEPLOY.md` steps 1–2.
  `curl https://<your-render-url>/health` returns `{"ok":true,...}`, and `https://<your-vercel-url>/simulator`
  loads and answers a sample enquiry.
- You have a Stripe account with **Test mode** on.

Call your deployed site's URL `$VERCEL` below (no trailing slash), e.g. `https://enquiry-to-paid.vercel.app`.

## 1. Get Stripe test-mode credentials

Follow `docs/SETUP.md` section 4, steps 1–2: Dashboard → stay in **Test mode** → **Developers → API keys** →
copy a secret key (`sk_test_...`, or a restricted `rk_test_...` scoped to Payment Links/Products/Prices
write + Events read). This is `STRIPE_SECRET_KEY`.

## 2. Decide how the webhook will reach you, and get `STRIPE_WEBHOOK_SECRET`

Pick ONE:

- **One-off CLI forward** (fastest, good for this single proof): install the Stripe CLI, `stripe login`, then
  ```
  stripe listen --forward-to https://<your-vercel-url>/api/webhooks/payments/stripe
  ```
  It prints `Ready! Your webhook signing secret is 'whsec_...'`. Keep this terminal running through step 6 —
  it must be live at the moment you pay.
- **Durable dashboard endpoint**: Stripe Dashboard → **Developers → Webhooks → Add endpoint** → URL
  `https://<your-vercel-url>/api/webhooks/payments/stripe` → events
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `charge.refunded` (these are the exact four event types
  `agent/src/payments/stripe-sim.ts`'s `parseEvent` acts on — **not** `payment_intent.payment_failed`, which
  this code never looks at). Stripe shows its own `whsec_...` once the endpoint is created.

Either way you now have a `whsec_...` value. That is `STRIPE_WEBHOOK_SECRET`.

## 3. Set Render env vars and redeploy

On the Render dashboard, for the agent service, set:

- `STRIPE_SECRET_KEY` = the `sk_test_...` (or `rk_test_...`) from step 1
- `STRIPE_WEBHOOK_SECRET` = the `whsec_...` from step 2
- `PAYMENTS_PROVIDER` = `stripe`

The third one matters and is easy to miss: `agent/src/server/serve.ts` only constructs a live `stripe`
provider when both Stripe env vars are present, but which provider new quotes actually use is controlled by
`PAYMENTS_PROVIDER` (read in the same file; default is `razorpay` if its keys are set, else `razorpay-sim`).
Setting it to `stripe` makes the deployed `/chat` playground route call
`setTenantPaymentProvider(pool, tenantId, "stripe")` (in `agent/src/simulator/chat.ts`, which the playground's
`/chat` handler always calls) on every enquiry it serves — this is the only operator-facing switch that
exists today for this (there is no separate CLI or UI for it; see `agent/README.md`'s T16 ruling: "the setter
is operator code"). **Side effect to know about:** while `PAYMENTS_PROVIDER=stripe` is set, every tenant
reached through the public playground gets switched to Stripe, not just the one you're testing with — switch
it back to `razorpay` (or remove it) and redeploy once you're done, if you want the playground back to
demoing Razorpay for Indian rate cards.

Save the env vars; Render redeploys automatically. Confirm with `curl https://<your-render-url>/health` again,
and check the service's boot log line for `payments=stripe`.

## 4. Trigger a real quote with a real Stripe Payment Link

Use this exact, known-good enquiry (it is the one `agent/src/server/app.test.ts` already proves produces a
`quote`, against the banquet rate card):

```
curl -s -X POST https://<your-vercel-url>/api/sim \
  -H "content-type: application/json" \
  -d '{"text":"Hi, wedding reception for 150 guests, Saturday 12 December 2026","customerRef":"live-proof-01","card":"rate-cards/fictional-banquet.json"}'
```

(You can also do this by hand in the browser at `https://<your-vercel-url>/simulator`, picking the "Banquet"
card and typing the same sentence — but then you must read the thread id back out of the browser's network
tab, because the UI never displays it. The curl form above is given so you control and can predict every id.)

The JSON response has two fields you need:

- `reply`: contains the quote text and a real Stripe Payment Link URL (`https://buy.stripe.com/test_...` in
  test mode, not the simulator's `.invalid` host) — this proves `stripeLive` actually called Stripe's API.
- `ledgerRow.payload.kind`: should be `"quote"`. `ledgerRow.threadId` should read
  `tenant-web-banquet:thread:chat:live-proof-01` — this is `<tenantId>:thread:chat:<customerRef>`, where
  `tenantId` for this card is `tenant-web-banquet` (`agent/src/server/app.ts`'s `tenantForCard`). You will use
  this exact thread id in step 7.

If `reply` instead shows a `.invalid` simulated link, `PAYMENTS_PROVIDER` or the Stripe env vars from step 3
did not take effect — re-check them before continuing.

## 5. Pay the link by hand with Stripe's documented test card

Open the Payment Link URL from `reply` in a browser. Pay with:

- Card number `4242 4242 4242 4242`
- Any future expiry date, any 3-digit CVC, any billing postal code

(Stripe's test-card list can change; `docs/SETUP.md` section 4 step 7 has the same card plus a decline case —
check Stripe's own current testing page if this one ever stops working.)

## 6. Watch the webhook actually fire

- If you used `stripe listen` (step 2's first option): the terminal where it's running prints the forwarded
  `checkout.session.completed` event and the deployed agent's HTTP response to it.
- If you used a dashboard endpoint (step 2's second option): Stripe Dashboard → your endpoint → **Event
  deliveries** shows the event and a `200` response.

Either way, the agent's own logs (Render dashboard → Logs) print a line like
`[webhook] stripe -> collected` the moment it processes the event.

## 7. Confirm with the existing ledger proof CLI — this is the actual evidence

From your own machine, with the agent repo checked out and `DATABASE_URL` set to the **same** Supabase
connection string Render uses (session pooler, port 5432 — see `docs/SETUP.md` section 1):

```
cd agent
DATABASE_URL="<the same DATABASE_URL Render has>" pnpm ledger proof tenant-web-banquet:thread:chat:live-proof-01
```

(If you used a different `customerRef` or `card` in step 4, substitute the matching thread id — it is always
`<tenantId>:thread:chat:<customerRef>`, and `tenantId` for `rate-cards/fictional-banquet.json` is
`tenant-web-banquet`.)

A successful result looks like this:

```
thread tenant-web-banquet:thread:chat:live-proof-01 (tenant tenant-web-banquet)
billable: yes (<amount> minor units INR)
why: ok
chain verified: yes
  #001 ... quote            <hash>  ...
  #002 ... payment_link      <hash>  ...
  #003 ... collected         <hash>  ...
```

This is the thing V13's "Done when" literally asks for: a real `providerPaymentId` (visible in the `collected`
row's full payload if you inspect it, or via `GET https://<your-vercel-url>/api/sim?customerRef=live-proof-01&card=rate-cards%2Ffictional-banquet.json`,
which proxies to the agent's `/payment-status` and returns `{"payment":{"provider":"stripe","status":"collected",...}}`)
in a real ledger row — `billable: yes` is the plain-English version of the same fact. If instead you see
`billable: no` with `why: not_collected`, the webhook has not reached the agent yet (check Render's free-tier
cold start — `docs/DEPLOY.md`'s "Known tradeoff" section — and retry after a few seconds; `stripe listen` and
the dashboard both retry automatically).

## What this checklist does NOT cover

- Deploying the agent and site in the first place (V1) — this page assumes that already happened.
- Switching a single tenant to Stripe without affecting every other tenant on the public playground — no such
  control exists yet (see the note in step 3); only a whole-process default via `PAYMENTS_PROVIDER`.
- A real WhatsApp-triggered enquiry (T25/WhatsApp wiring is not live yet) — step 4 uses the playground, the
  only customer-facing path that is live today, exactly as the ticket allows ("through the playground or
  WhatsApp, whichever is live at the time").
