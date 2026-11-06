# Tickets: Enquiry to Paid

Derived from `prd/PRD.md`. Every ticket is a **vertical slice**: it cuts through every layer it needs (input → extraction → kernel → ledger → reply) and ends in something you can run and watch. No ticket is "build the database" or "build the kernel" on its own.

**Honesty rule for all tickets:** every rate card, business and conversation is fictional and labelled. No ticket may claim accuracy, customers or volumes for the real agent.

**Sizes:** S ≈ 1 day, M ≈ 2–3 days, L ≈ 4–5 days (solo).

**v0 boundary:** T0–T14. Everything after is post-v0.

---

## Phase A — Tracer bullet and the safety spine

### T0 — Spike: Rust kernel bridge (timeboxed 1 day)
- **Slice:** Install Rust, compile a trivial `evaluate()` in Rust, call it from TypeScript (WASM vs napi), run it in a test.
- **Demo:** `pnpm test` calls Rust and returns a value.
- **Done when:** one bridge approach is chosen and recorded in a short decision note; if it fails the timebox, TS kernel behind the same interface is chosen instead.
- **Depends on:** none. **Size:** S. **PRD:** §3, §14.

### T1 — Tracer bullet: one enquiry → one quote → one ledger row
- **Slice:** Fixture-extracted fields for a fictional banquet enquiry → kernel prices it from one fictional rate card (integer minor units, tax as a line, rule IDs, `validUntil`) → ledger row (rate-card hash, no tamper protection yet) → simulator prints the WhatsApp-style reply with kernel numbers injected by code. Includes Postgres migration with `tenant_id` on every table, the repo layout from the PRD, and CI (lint, tests, offline eval, `ledger verify`) on every push with no secrets in git and no raw phone numbers in logs.
- **Demo:** `pnpm sim run fixtures/banquet-01.json` prints a line-itemised quote and the stored ledger row.
- **Done when:** same input gives byte-identical output across 100 runs; reply contains no number absent from kernel output.
- **Depends on:** T0. **Size:** L. **PRD:** US1, US3, US6 (partial).

### T2 — Refusal path: out-of-coverage enquiry → typed refusal
- **Slice:** An enquiry the card doesn't cover → kernel returns typed `Refusal` (reason code, rule gap) → safe holding reply → ledger row → escalation event to a stub notifier.
- **Demo:** run a "300-guest wedding in a month the card doesn't cover" fixture and see the holding reply plus the escalation log line.
- **Done when:** property test shows no input produces a quote line without a `ruleId`; refusal reasons are exhaustive enums.
- **Depends on:** T1. **Size:** M. **PRD:** US4, US5.

### T3 — Missing information: ask, then quote
- **Slice:** Enquiry missing a required field → thread state machine asks only for that field (question text from the card's `requiredFields`) → follow-up message completes it → quote. Customer-facing wording is templated in v0 (LLM wording comes with T6).
- **Demo:** two-message fixture conversation ends in a quote; a one-message incomplete enquiry ends with a single clarifying question.
- **Done when:** the agent never asks for a field the card doesn't require; thread state persists across messages.
- **Depends on:** T1. **Size:** M. **PRD:** US1, US2.

### T4 — Tamper-evident ledger
- **Slice:** Harden the ledger from T1: DB triggers block UPDATE/DELETE, rows hash-chain, corrections are compensating entries, `ledger verify` CLI walks the chain (verification implemented in the kernel).
- **Demo:** edit a row by hand in psql (blocked); disable the trigger, edit anyway, and `ledger verify` reports the exact broken row.
- **Done when:** all ledger acceptance criteria in PRD US6 pass.
- **Depends on:** T1. **Size:** M. **PRD:** US6.

### T5 — Tenant isolation and org roles
- **Slice:** Row-level security on all tables (tenant ID set with `SET LOCAL` per transaction, direct pooled connection, Supabase Data API disabled and tested as unreachable); Better Auth with the organization plugin on Drizzle/Postgres mapped to tenant → members → roles (owner/manager/staff); two fictional tenants; a query as tenant A cannot see tenant B's threads, cards or ledger rows.
- **Demo:** run the same enquiry under two tenants with different cards; cross-tenant read attempts fail.
- **Done when:** RLS tests pass for every table; PII columns encrypted; phone numbers hashed for lookup.
- **Depends on:** T1. **Size:** M. **PRD:** §3 constraints, §8.

---

## Phase B — The model at the edge, measured

### T6 — Live extraction through a swappable LLM provider (Groq)
- **Slice:** `LlmProvider` interface + Groq implementation + recorded-fixture mode; schema-validated extraction of an English enquiry replaces the fixtures from T1; LLM-worded reply with numbers injected by code; low-confidence → confirm-back or refusal; per-call cost, model ID and region stored in the ledger.
- **Demo:** type an English enquiry into the simulator, get a quote end to end with a real Groq call; replay the same run offline from fixtures.
- **Done when:** schema-invalid output is rejected; provider failure yields a holding reply and never a quote; ledger rows carry model/provider/region/cost.
- **Depends on:** T1, T2, T4. **Size:** L. **PRD:** US2, US8.

### T7 — Eval harness with Hinglish and English sets
- **Slice:** Hand-labelled fictional enquiries (30+ across English and Hinglish), a CLI that runs extraction and the full pipeline against them, and a published per-language results file in the repo, bad numbers included. Baseline stored by model ID + prompt hash.
- **Demo:** `pnpm eval` prints a per-language table and writes `eval/baselines/<model>.json`.
- **Done when:** results are reproducible from fixtures; CI runs the offline eval; numbers are labelled as measured on fictional data.
- **Depends on:** T6. **Size:** L. **PRD:** US9, §2 metrics.

### T8 — Adversarial inputs, no negotiation, honest disclosure
- **Slice:** Adversarial set (prompt injection, price anchoring, "ignore your rules", discount and package-deal requests, "are you a bot?"). Discount/negotiation → refusal + escalation. Disclosure reply in English and Hinglish.
- **Demo:** run the adversarial suite; show 0 quotes issued and the disclosure reply.
- **Done when:** all adversarial cases refuse or answer honestly; customer text never reaches the kernel as anything but typed fields.
- **Depends on:** T6, T2. **Size:** M. **PRD:** US11, US12, US9.

### T9 — Provider swap gate
- **Slice:** Add a second (fixture/alternate) provider to prove the interface; a gate that blocks enabling a provider or model whose per-language eval is worse than the recorded baseline; region logging per call.
- **Demo:** switch provider by config; attempt to enable a deliberately weaker fixture model and see it blocked.
- **Done when:** swap needs config only; gate output names the language and metric that regressed.
- **Depends on:** T7. **Size:** M. **PRD:** US8.

---

## Phase C — Generality, availability, approval

### T10 — Availability and holds (native)
- **Slice:** Native availability table with chat-style block commands, 48h auto-expiring holds shown in the quote, taken date → refusal-style reply, expired quotes re-evaluated against the current card and availability.
- **Demo:** two enquiries for the same Saturday: first gets a quote and a hold, second is told the date is unavailable; advance the clock and the hold releases.
- **Done when:** no quote is ever issued for an unavailable date; hold expiry is durable across restarts (Postgres timers).
- **Depends on:** T1, T3. **Size:** L. **PRD:** US7.

### T11 — Second vertical: photographer card
- **Slice:** Fictional photographer rate card (packages, travel, extra hours) priced by the same engine, with whatever rules-language additions it needs; end-to-end from enquiry to quote.
- **Demo:** photographer fixtures produce quotes through the same pipeline with no vertical-specific code.
- **Done when:** engine changes are in the generic rules language, not special-cased.
- **Depends on:** T1, T2. **Size:** M. **PRD:** §1 generality, §2 metrics.

### T12 — Third vertical: B2B supplier card
- **Slice:** Fictional B2B supplier card with unit price, MOQ, volume tiers and GST priced end to end.
- **Demo:** quotes under and over MOQ and tier boundaries; below-MOQ orders refuse or re-quote per card.
- **Done when:** tax lines and tier boundaries have property tests; no floating-point money anywhere.
- **Depends on:** T11. **Size:** M. **PRD:** §2 metrics.

### T13 — Fourth vertical: contractor card (refusal-heavy)
- **Slice:** Fictional contractor card where most jobs need a site visit; the engine quotes only the narrow covered cases and refuses the rest with useful escalations.
- **Demo:** run the contractor set and show a majority of refusals, each with a reason and a booked-visit suggestion where the card allows.
- **Done when:** refusal share is reported in the eval output; zero out-of-coverage quotes.
- **Depends on:** T11. **Size:** S. **PRD:** US4.

### T14 — Rate-card compile, approval and activation gate
- **Slice:** Template file (CSV/Sheet-shaped) → compiler → validated, hashed rule file; compile errors name the exact cell; worked-example read-backs generated from the card ("Saturday in December, 200 guests, Gold = ₹X, correct?") with simulated yes/no replies; an unapproved or edited card cannot quote until re-approved.
- **Demo:** break a cell and see the exact error; approve via simulated read-backs; edit after approval and watch quoting stop until re-approval.
- **Done when:** PRD US10 criteria pass.
- **Depends on:** T1, T2, T5. **Size:** L. **PRD:** US10.

> **v0 complete after T14.** Next: run the real owner interview (see T27) before shaping the cards further.

---

## Phase D — Post-v0 (channel, money, owner, Google)

### T15 — Collection via Razorpay (India)
- **Slice:** `PaymentProvider` interface + Razorpay implementation: payment link in the reply, webhook writes the only `collected` ledger entry, per-job proof endpoint answers "billable: yes/no, why".
- **Demo:** simulated webhook flips a thread to `collected`; `ledger proof` prints the billable chain.
- **Depends on:** T4, T10. **Size:** L. **PRD:** US6, billing rules.

### T16 — Payments outside India (Stripe Payment Links adapter)
- **Slice:** Second `PaymentProvider` implementation proving the interface; per-tenant provider selection.
- **Depends on:** T15. **Size:** M.

### T17 — Owner interface over WhatsApp (simulated)
- **Slice:** Daily digest message, refusal escalations with quick replies ("quote ₹__ / decline / call them"), and "why" answers built from the ledger, all driven through the simulator.
- **Depends on:** T2, T4, T5. **Size:** L.

### T18 — Owner takeover and handback
- **Slice:** Any owner/manager message pauses the thread; explicit handback or 12h idle resumes; owner-sent prices flagged non-billable.
- **Depends on:** T17, T15. **Size:** M.

### T19 — Chasers with consent
- **Slice:** Consent ledger entry required, 24h and 72h chasers then stop, stop-words honoured in supported languages, template use outside the 24h window (simulated).
- **Depends on:** T10, T17. **Size:** M.

### T20 — Voice notes in
- **Slice:** Transcription stage in the pipeline with a confidence gate; low confidence → confirm-back or refusal; Hinglish transcript eval added to the harness.
- **Depends on:** T7. **Size:** L.

### T21 — Google Calendar as availability provider
- **Slice:** `AvailabilityProvider` Calendar implementation: free/busy reads, tentative hold events with expiry, confirmed on payment, mismatch with Postgres → refusal + escalation. Per-tenant OAuth with minimal scopes, tested in a dedicated test Workspace. Includes a ticket-sized check of current Google OAuth verification requirements.
- **Depends on:** T10, T15. **Size:** L.

### T22 — Google Sheets as rate-card source
- **Slice:** Sheet template → compile → snapshot with Drive revision ID pinned; edits don't affect quoting until re-approved.
- **Depends on:** T14, T21. **Size:** M.

### T23 — Google Sheets ledger mirror
- **Slice:** One-way append-only mirror of ledger events to an org Sheet, with a "read-only copy" header row.
- **Depends on:** T4, T21. **Size:** S.

### T24 — Docs templates → PDF quotes and confirmations
- **Slice:** Docs template merge from kernel output, PDF export via Drive, PDF hash in the ledger, sent as an attachment in the simulator.
- **Depends on:** T21, T10. **Size:** M.

### T25 — Real WhatsApp Cloud API number
- **Slice:** Webhook verification, template registration, opt-in handling, a real test number replacing the simulator for a closed pilot; requires a compliance review first (private doc, not committed).
- **Depends on:** T17, T19, T15. **Size:** L.

### T26 — Site migration to React Router v8
- **Slice:** Move the marketing site from Next 15.5 to React Router v8 framework mode, serving webhooks and API routes from the same app; visual system unchanged.
- **Depends on:** T25 (or earlier if the site needs it). **Size:** L.

### T27 — Non-code: owner interview, wording, glossary
- **Slice:** One hour with a real owner writing down how they price; update fictional cards and the rules language from it; write `GLOSSARY.md`; revise README/PRODUCT "not the target" line to reflect small teams; five revenue-share conversations before any price page.
- **Depends on:** none (schedule early; it can reshape T11–T14). **Size:** M.

### T28 — Kill switch: refuse-everything mode
- **Slice:** A global (and per-tenant) flag, checked at the start of the pipeline, that makes every inbound message take the refusal path with a holding reply and an escalation, recorded in the ledger with who flipped it and when.
- **Demo:** flip the flag mid-conversation; the next message gets a holding reply and no quote; flip back and quoting resumes.
- **Done when:** no code path can quote while the flag is on; flag changes are ledger entries.
- **Depends on:** T2, T4. **Size:** S. **Must land before:** T25.

### T29 — Pilot readiness checklist
- **Slice:** Stand up staging and prod on Supabase Mumbai with point-in-time recovery and a rehearsed restore; PII key held outside the database; webhook signature checks, idempotency keys and replay protection; per-phone rate limits; PII-free error tracking and alerts; data-processing agreements signed with Supabase, Groq and Meta; retention and deletion policy; incident runbook.
- **Demo:** restore prod to a point in time into staging and verify the ledger chain; replay a webhook and see it ignored.
- **Done when:** every item is checked in `tickets/PILOT-CHECKLIST.md` (created by this ticket). No real customer traffic before this is complete.
- **Depends on:** T5, T4, T28. **Size:** L. **Must land before:** T25.

---

## Dependency map (v0)

```
T0 → T1 → T2 → T8
      ├→ T3 → T10
      ├→ T4 → T6 → T7 → T9
      ├→ T5 → T14
      └→ T11 → T12
             └→ T13
T6 needs T2, T4 · T8 needs T6 · T14 needs T2, T5
```

## Suggested first week
T0 → T1 → T2 → T4 in order, with T27 (the owner interview) booked in parallel.
