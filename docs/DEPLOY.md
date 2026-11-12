# Deploy guide: agent on Render, site on Vercel

Written for one stable pair of URLs so Razorpay/Stripe/the playground never need a `cloudflared` tunnel again. The agent (auth + chat + payments + playground) is one process; the Next.js site is the other. Deploy the agent first — the site needs its URL.

Everything below is test-mode / fictional data, same as local dev.

---

## 1. Render (the agent)

1. **Sign up / sign in** at render.com with GitHub. No card required for the free web-service tier.
2. **New -> Web Service**, connect the `enquiry-to-paid` repo.
3. Settings:
   - **Root directory:** `agent`
   - **Runtime:** Node
   - **Build command:** `pnpm install --frozen-lockfile` (NOT `corepack enable && pnpm install ...` — Render's current Node images already ship pnpm pre-wired via corepack at `/usr/bin/pnpm`, and `corepack enable` fails trying to re-link that same read-only path: `EROFS: read-only file system, unlink '/usr/bin/pnpm'`. pnpm is already on `PATH` and already honors this repo's `packageManager` pin, so just call it directly.)
   - **Start command:** `pnpm start` (NOT `pnpm serve` — that script reads `tsx --env-file=.env`, which fails hard with `node: .env: not found` on Render, since Render injects env vars directly into the process rather than via a `.env` file. `pnpm start` runs the same `serve.ts` without that flag.)
   - **Instance type:** Free
4. **Environment variables** — add every line from `agent/.env` that has a value (not the file itself; paste each key/value into Render's dashboard). Do **not** set `PORT` — Render injects it itself and `serve.ts` already reads it.
5. Create the service. Render builds and gives you a URL like `https://e2p-agent.onrender.com`.
6. **Verify:** `curl https://e2p-agent.onrender.com/health` should return `{"ok":true,...}`.

## 2. Vercel (the site)

1. **Sign up / sign in** at vercel.com with GitHub, **New Project**, import the same repo.
2. **Root directory:** leave as the repo root (where `next.config.ts` lives).
3. **Environment variable:** `AGENT_URL` = the Render URL from step 1 (no trailing slash), e.g. `https://e2p-agent.onrender.com`.
4. Deploy. Vercel gives you a URL like `https://enquiry-to-paid.vercel.app`.
5. **Verify:** open `https://<your-vercel-url>/simulator`, run a sample enquiry, confirm a quote comes back (this round-trips through Vercel -> Render -> Groq -> Supabase and back).

## 3. Point the webhooks at the stable URL

Once both are deployed, every webhook form gets the **Vercel** URL (it proxies to Render), never the Render URL directly:

- **Razorpay:** Account & Settings -> Webhooks -> edit the existing webhook -> URL = `https://<your-vercel-url>/api/webhooks/payments/razorpay`. Secret stays whatever is already in `RAZORPAY_WEBHOOK_SECRET`.
- **Stripe (when tested live the same way):** Developers -> Webhooks -> Add endpoint -> `https://<your-vercel-url>/api/webhooks/payments/stripe`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `charge.refunded` (these are the four event types `agent/src/payments/stripe-sim.ts`'s `parseEvent` actually acts on — **not** `payment_intent.payment_failed`, which this code never looks at and Stripe's own Payment Links/Checkout fulfilment guide does not use either). Stripe will show its own `whsec_...` for this endpoint — update `STRIPE_WEBHOOK_SECRET` on **Render** (not Vercel) to that value and redeploy the agent. Full step-by-step proof checklist: `docs/STRIPE-LIVE-PROOF.md`.

## 4. Google OAuth redirect URI

Add the deployed callback to your Google client's **Authorized redirect URIs**:
`https://<your-vercel-url>/api/auth/callback/google`
(Keep the `localhost:3000` one too, for local dev.)

Also set `BETTER_AUTH_URL=https://<your-vercel-url>` as a **Render** env var (it's read by the agent, not the site), so Better Auth builds the right callback URL in production.

---

## Known tradeoff: Render's free tier sleeps

After ~15 minutes with no traffic, the free instance spins down. The next request (a visitor opening the playground, or a webhook arriving) triggers a cold start — usually under a minute, but not instant. Razorpay and Stripe both retry a webhook that doesn't respond in time, so a payment is never silently lost, just slightly delayed on the very first hit after idle. If this becomes annoying for demos, Render's cheapest paid tier removes the sleep.

## Redeploying after a code change

Both Render and Vercel redeploy automatically on a push to `main` (once connected). No manual step needed beyond `git push`.
