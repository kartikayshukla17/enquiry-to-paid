# PRD: v1 — Owner console, free-tier-safe plumbing, hardened money, WhatsApp last

> Status: every decision below was settled in a grilling session on 2026-11-11 (full exchange in the session log; not reproduced here). This is a build brief, not an open discussion — where the session corrected an earlier plan (resequencing away from WhatsApp-first, the Render free-tier constraint, the Groq spend question), only the final answer is recorded.
> Builds on `prd/PRD.md` (v0, done and verified) and supersedes the ordering in `tickets/V1-TICKETS.md`'s earlier draft, which this PRD's own session revised. Ticket numbers (`V1`-`V14`) below match that file exactly.

---

## 1. Overview

**Project name:** Enquiry to Paid — v1

**Problem statement:**
v0 proved the pricing core works: deterministic, refusal-safe, provably ledgered. But it has no face — nobody besides Kartikay, reading raw ledger rows, can see a conversation happen, a quote get challenged, or a human take over. It also has no channel beyond a local simulator, and its "production" posture (a job queue, a spend ceiling, money reconciliation) was never built past what a single demo session needs. v1 closes the gap between "the core works" and "a stranger could watch it work."

**Proposed solution:**
Ship an owner console as the actual product surface (not WhatsApp first, which is outside this project's control twice over), make the whole thing run safely and for free on hosted infrastructure, close every loose end in the money path, and treat a real WhatsApp number as something to bolt on opportunistically once Meta's review clears — not something to wait for.

**AI build summary:**
> Extend the existing Next.js (Vercel) + single Node agent (Render, `agent/src/server/app.ts`) + Supabase Postgres architecture. Add: a real self-serve tenant sign-up and an owner-only console (inbox, thread detail, quote/ledger viewer with the chain-verify badge, escalation takeover/handback — built against the playground's own real escalations, not a live channel); a `POST /tick` endpoint triggered by a GitHub Actions cron (Render's free tier has no background-worker option — confirmed, not assumed); per-thread ordering via Postgres `SKIP LOCKED`, no Redis; a global (not per-tenant) daily ceiling on Groq request volume with an honest refusal message, because Groq's free tier cannot auto-bill and there is no dollar amount to cap; webhook-time quote-revalidation and refund/failed-payment ledger events; Stripe proven live the same way Razorpay already was. WhatsApp (Meta Cloud API) is built last, scoped to a 5-recipient sandbox demo, attached to a proper Meta Business Manager. No change to the kernel, the ledger contract, or the RLS/tenant model.

---

## 2. Goals & Success Metrics

**Primary goal:** Make the product demoable and legible to someone who isn't Kartikay reading a terminal — without taking on a single dollar of infrastructure cost, and without the plan depending on Meta's timeline.

**Success metrics:**
- A new visitor can sign up, see their own tenant's conversations, quotes and a verified ledger, and take over an escalation — with zero manual setup from Kartikay.
- The service runs continuously on free hosting tiers only; no credit card is ever charged for Render, Groq, or any plumbing added in this phase.
- A real payment, real refund-event, and a real expired-quote collection all behave correctly against the deployed (not local) stack.
- WhatsApp's absence or presence never blocks any other v1 ticket from shipping.

**Anti-goals:**
- Not changing how a quote is priced, refused, or ledgered — the kernel is untouched.
- Not building multi-role (staff/manager) UI yet — exactly one role (owner) is tested in v1.
- Not building in-app rate-card editing — no one but Kartikay edits cards, and he does it as JSON today.
- Not treating a WhatsApp sandbox as "a public number" — it demos to up to 5 pre-approved phones, nothing more, until real business verification clears.
- Not spending money — every new piece of infrastructure in this phase is free-tier by design, not by accident.

---

## 3. Scope & Constraints

**In scope:** `V1, V3-V14` as defined in `tickets/V1-TICKETS.md`.

**Out of scope:** `UI-TICKETS.md`'s U6-U11 (rate-card editing UI, payments view, settings, audit export, marketing truth pass); T20-T24, T26 (voice, Google integrations, React Router v8); full T29 pilot compliance (disaster recovery, access audit, independent security review) — all deferred until a real pilot owner exists.

**Technical constraints:**
- Platform: Next.js on Vercel + one Node process on Render, as already built (`agent/src/server/serve.ts`).
- **Hard constraint, confirmed via Render's own staff:** the free tier has no background-worker, private-service, or cron-job option at all — any "always-on" design that assumes one is wrong. Scheduling work must ride on either the existing web service (triggered externally) or be abandoned in favor of that.
- **Hard constraint, confirmed via Groq's own account terms:** the free tier needs no card and never auto-bills; moving to paid is a deliberate, separate action nobody is taking. A "spend cap" expressed in dollars is therefore a category error — the real ceiling is Groq's own free-tier request/token limit, shared across every tenant on one API key.
- Auth: the owner console's tenant/org model reuses Better Auth exactly as already built; no new auth system.
- Money: every new payment-related behavior (webhook revalidation, refund events) must go through the existing `handleWebhook`/ledger seam — no second code path that can write `collected`.
- Data residency: unchanged from v0 (Supabase Mumbai).

---

## 4. User Stories

| ID | Role | Action | Benefit |
|----|------|--------|---------|
| US1 | Visitor | sign up and get my own tenant | I can try the product without Kartikay provisioning anything by hand |
| US2 | Owner | see every conversation and its outcome in one place | I don't have to read raw ledger rows to know what's happening |
| US3 | Owner | see a quote's line items, rule IDs and chain-verify status | I trust the number without taking it on faith |
| US4 | Owner | take over a flagged conversation and hand it back | I stay in control of anything the agent refuses to decide alone |
| US5 | Kartikay | know the service never silently exceeds a free tier | I never get surprised by a bill or a dead service at 2am |
| US6 | Kartikay | know a quote can't be honored at a stale price | money collected always matches a price that was still valid |
| US7 | Kartikay | see a refund or failed payment as a typed event | the ledger stays the single source of truth for what actually happened with money |
| US8 | Kartikay | eventually demo on a real WhatsApp number | the product looks real to someone who doesn't read code |

---

## 5. Proposed Experience

**Owner console, end to end:** sign up → land on an empty inbox with a clear "nothing yet, try the playground" state → a conversation arrives (from the playground, or later WhatsApp) → open the thread → see the quote, its lines, its rule IDs, and a chain-verify badge that turns red if the ledger were ever tampered with → an escalation appears in its own queue → take over → reply as a human → hand back, agent resumes silently.

**Error/empty states:** no conversations yet (new tenant); a quote whose chain fails verification (shown loudly, not hidden); a payment held for manual review because its quote expired before it was paid (shown distinctly from a normal `collected` state, never silently auto-honored).

**Accessibility:** same bar as the rest of the site (`DESIGN.md`) — keyboard-operable, screen-reader-labeled, AA contrast minimum.

---

## 6. Data Models

No new tenant-data tables beyond what `UI-TICKETS.md`'s U1-U5 already implies (tenant-scoped reads over existing `threads`/`ledger_entries`/`payments`). Two new, deliberately small, non-tenant tables support the plumbing redesign:

```sql
-- supports V9 (per-thread ordering): claims one thread's pending work at a time
CREATE TABLE thread_work_queue (
  thread_id    text PRIMARY KEY REFERENCES threads(id),
  claimed_at   timestamptz,        -- NULL = unclaimed; SKIP LOCKED makes two tick runs never double-process one thread
  claimed_by   text                -- a run id, for diagnosing a stuck claim
);

-- supports V10 (global Groq ceiling): one row per day, incremented by every extraction call, across all tenants
CREATE TABLE groq_daily_usage (
  day     date PRIMARY KEY,
  count   int NOT NULL DEFAULT 0
);
```

Both are exempt from the tenant/RLS model for the same reason `kill_switch_global` already is (see `agent/src/tenancy/exempt.ts`): they hold no tenant data, and are touched only by the agent's own trusted pool connection.

---

## 7. API / Integration Surface

| Method | Path | Description | Ticket |
|--------|------|--------------|--------|
| POST | `/tick` (agent, new) | claims and processes due work (hold expiry, chasers, digest) via `thread_work_queue`; called by a scheduled GitHub Actions workflow every 5 minutes | V7, V9 |
| * | `/api/app/*` (agent, new) | tenant-scoped reads for the console (threads, ledger entries, payments), gated by session + `withTenant` | V3 |
| POST | `/api/app/organizations` (agent, new) | real self-serve tenant creation (Better Auth's organization create, already wired, exposed through the console UI) | V3 |
| POST | `/api/app/threads/:id/takeover` \| `/handback` (agent, new) | escalation takeover/handback, writes the existing owner-message ledger entries | V6 |

**External integrations:**
- **GitHub Actions** (new use, not a new service) — a scheduled workflow replacing a would-be Render cron job.
- **Stripe** — no new integration, just proving the existing adapter live (V13).

---

## 8. Acceptance Criteria

**US1 — Real sign-up**
- [ ] A new visitor can create an organization (tenant) with no action from Kartikay.
- [ ] That tenant starts with zero conversations and a clear empty state, never another tenant's data.

**US2/US3 — Inbox and ledger viewer**
- [ ] Every thread visible in the console belongs to the signed-in tenant only (cross-tenant isolation test, same discipline as v0's RLS tests).
- [ ] A quote's displayed lines, rule IDs and total come only from the kernel-produced ledger payload — the console never computes or re-derives a number.
- [ ] A tampered ledger row makes the chain-verify badge show failed, sourced from a real server-side `ledger verify`, not a client-side guess.

**US4 — Takeover/handback**
- [ ] While a thread is taken over, the agent sends nothing automatically (same guarantee already tested at the pipeline level).
- [ ] Every takeover and handback action is its own ledger row naming the acting member.

**US5 — Free-tier safety**
- [ ] `/tick` is the only source of scheduled work; nothing assumes an always-on background process exists.
- [ ] `groq_daily_usage` refuses a new extraction with a plain, honest message once it nears Groq's actual published ceiling for the model in use — verified against the real number in the Groq console, not a blog-reported figure.
- [ ] No code path in this phase can cause a Groq or Render bill without a human first adding a payment method somewhere by hand.

**US6 — Quote revalidation at payment time**
- [ ] A payment arriving for a quote whose `validUntil` has passed is held in a distinct "needs review" status, never auto-marked `collected`.
- [ ] A payment for a still-valid quote collects exactly as it does today (Razorpay's live proof from 2026-11-10 keeps passing).

**US7 — Refund/failed-payment events**
- [ ] A `payment.failed` or refund webhook writes a typed ledger entry distinct from `collected`.
- [ ] The ledger chain still verifies with these new entry types present.

**US8 — WhatsApp (last, opportunistic)**
- [ ] A message to the sandbox number from one of up to 5 pre-approved phones round-trips a real quote through the same `handleMessage` pipeline the simulator uses — no separate pricing logic.
- [ ] A request with an invalid `X-Hub-Signature-256` is rejected before touching the pipeline.
- [ ] The integration is attached to a Meta Business Manager, never a second personal Facebook account.

---

## 9. Open Questions & Risks

- **Risk:** GitHub Actions' scheduled-workflow timing isn't to-the-second — a 5-minute tick can slip under load. *Mitigation:* acceptable for a free, demo-stage service; move to a paid Render worker only if real traffic needs tighter timing.
- **Risk:** Groq's actual free-tier numbers vary by source and may change. *Mitigation:* `V10`'s threshold is read from the Groq console directly at build time, not hand-copied from a blog, and re-checked if Groq's own limits page changes.
- **Risk:** Meta's business-verification timeline remains outside this project's control. *Mitigation:* nothing else in v1 depends on it (that's the point of this resequencing).
- **Tradeoff:** building a real self-serve sign-up (US1) is more work than a pre-seeded tenant would have been, for an audience of effectively one person today — accepted deliberately, because this is meant to demo to someone else eventually.

---

## 10. Rollout & Next Steps

**Order (matches `tickets/V1-TICKETS.md`'s "Suggested order," which this PRD's own session set):**
1. `V3-V6` — owner console (the spine).
2. `V7, V9, V10` — plumbing, all free-tier-safe by design.
3. `V11-V13` — money hardening.
4. `V2` — WhatsApp, whenever Meta clears; gates nothing above it.
5. `V1` (deploy) and `V14` (informal owner conversations) run alongside all of the above, whenever each is ready.

**Sign-off needed from:** Kartikay only (solo project; every decision here is already final per the 2026-11-11 grilling session).

**Next steps:**
1. Build `V3` first (owner console sign-up + shell), test-first, one commit per ticket — *Owner: Claude, on request.*
2. Re-check the Meta Business Suite review status before starting `V2` — *Owner: Kartikay.*
