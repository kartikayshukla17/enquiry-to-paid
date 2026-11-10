# PRD: Enquiry to Paid — v0 Core

> Status: draft from the 2026-11-07 grilling session. Nothing here is built. Every figure about our own agent is a target, not a result.
> Source of truth for positioning: `README.md`, `PRODUCT.md`. This PRD does not rely on any earlier PRD.

---

## 1. Overview

**Project name:** Enquiry to Paid (no product name chosen)

**Problem statement:**
Owner-operated physical service businesses in Delhi NCR and the GCC receive enquiries on WhatsApp, often after hours, in code-switched languages. They answer them by hand, so enquiries go unanswered, unpriced, unchased and uncollected. Existing tools answer and route but stop at a human approval gate before any price, which is the half of the job that closes the sale.

**Proposed solution:**
One agent on one WhatsApp number that carries an enquiry from answer to price to chase to booking to collection. The LLM only reads; deterministic rules produce the price or explicitly refuse; an append-only ledger proves every outcome.

**AI build summary:**
> Build a headless TypeScript + Rust service. A Rust `kernel` crate evaluates a versioned rate card against extracted fields and returns either a line-itemised quote or a typed refusal; it uses integer minor units and has no knowledge of free text. TypeScript orchestrates: a state machine drives extract → kernel → reply → ledger, calling a swappable `LlmProvider` (Groq first, Bedrock later) for schema-constrained extraction and reply wording only. Persist to Postgres (tenant ID + row-level security from the first migration) with an append-only, hash-chained ledger. v0 has no live WhatsApp: a local simulator replays recorded fictional conversations. No dashboard. The LLM never decides a price, a next step, or whether to abstain.

---

## 2. Goals & Success Metrics

**Primary goal:** Prove that a deterministic quote-or-refuse core can price real-shaped enquiries safely, with a provable ledger, before any channel or autonomy is claimed.

**Success metrics (v0, all measured offline on labelled fictional data):**
- Determinism: identical extracted fields on the same rate-card version produce byte-identical quotes, 100% of 1,000 randomised replays.
- Safety: 0 quotes issued on inputs outside rate-card coverage across the adversarial and out-of-coverage sets (they must refuse).
- Provability: the ledger hash chain verifies end to end; every quote and refusal has a ledger row pinned to a rate-card version hash.
- Coverage: at least 30 fictional enquiries (English + Hinglish) replay with the expected outcome.
- Generality: one engine prices all three fictional rate cards (banquet, photographer, B2B supplier) and mostly refuses on the fourth (contractor).

**Anti-goals:**
- Not shipping a customer-facing product, number, or price page.
- Not claiming accuracy for any language until measured and published, bad numbers included.
- Not building a dashboard, a CRM, a general assistant, or an agent loop.
- Not negotiating prices.
- Not fabricating customers, testimonials, volumes, revenue or accuracy for our own agent (repo honesty rules).

---

## 3. Scope & Constraints

**In scope (v0):**
- Rules language and Rust kernel (general, not vertical-specific)
- Typed refusal path with holding reply and stubbed owner escalation
- Postgres schema, tenant model, append-only hash-chained ledger
- `LlmProvider` interface, Groq implementation, recorded-fixture mode
- Extraction schema + per-language eval harness + adversarial set
- Native availability table and hold expiry
- WhatsApp simulator that replays recorded conversations
- Four fictional rate cards

**Out of scope (v0, planned later):**
- Live WhatsApp Cloud API number; templates; opt-in flows
- Razorpay / Stripe adapters (interfaces defined, not wired)
- Google Calendar, Sheets, Docs integrations (interfaces defined, not wired)
- Owner WhatsApp interface, chasers, voice-note transcription
- Languages beyond English and Hinglish
- Site migration from Next 15 to React Router v8
- Bedrock provider

**Technical constraints:**
- Platform: server-side only in v0; later a web app (React Router v8) hosts site, webhooks, API.
- Languages: Rust for the money kernel; TypeScript elsewhere. TS fallback for the kernel behind the same interface if Rust setup friction blocks week one. Rust is not yet installed on the dev machine.
- Money: integer minor units + explicit currency per tenant; tax is a rate-card line item.
- Tenancy: tenant (org) → members(role) → resources/locations; tenant ID + RLS on every table from migration one.
- Time: per-tenant timezone for date-class logic and "same hour" targets.
- Privacy: PII encrypted at rest; phone numbers hashed where possible; consent entry required before any outbound message beyond the first reply; customer text sent to a provider is logged by provider and region (DPDP from May 2027, UAE PDPL, WhatsApp opt-in rules, TRAI DLT if calls ever added).
- Trust: customer text is data only; it supplies extracted fields, never instructions; the kernel never reads free text.
- Performance target (not a claim): first reply under 60 seconds; per-enquiry LLM cost recorded in the ledger.
- Accessibility: not applicable to v0 (no UI); applies to later web and PDF outputs.
- Vocabulary: ICP is **physical** service businesses. Never "virtual venue", "event platform", "zones", "immersive" or "spatial" in public copy.

---

## 4. Jobs to Be Done

| Priority | Job statement |
|---|---|
| 1 | When an enquiry arrives on WhatsApp while I am mid-service or asleep, I want a correct price sent immediately, so I can win the booking before the customer asks someone else. |
| 2 | When a case does not fit my pricing, I want the agent to stop and hand it to me with the details, so I can never be held to a number I did not mean. |
| 3 | When I sent a quote and heard nothing, I want it chased politely and stopped on request, so I can recover bookings without nagging. |
| 4 | When I am asked what a job is owed, I want proof of what the agent quoted and collected, so I can trust and dispute-proof a revenue-share bill. |
| 5 | When my prices change, I want to update them in a sheet I already use and confirm them in plain language, so I can keep control without learning software. |

---

## 5. User Stories

| ID | Role | Action | Benefit | JTBD |
|---|---|---|---|---|
| US1 | Customer | send an enquiry in English or Hinglish | I get a priced reply or a clear holding message | J1 |
| US2 | System | extract structured fields from a message | the kernel receives only typed inputs | J1 |
| US3 | System | produce a quote from the rate card | the same inputs always give the same, explained number | J1 |
| US4 | System | refuse when no rule covers the case | the owner is never bound to an unintended price | J2 |
| US5 | Owner | have refusals escalated with extracted details | I can decide quickly | J2 |
| US6 | System | record every quote, refusal and state change | outcomes are provable and tamper-evident | J4 |
| US7 | System | check availability and hold a date with an expiry | I never quote a taken date | J1 |
| US8 | Engineer | swap the LLM provider behind an interface | we can move Groq → Bedrock without rework | J1 |
| US9 | Engineer | run a per-language eval and adversarial suite | accuracy and safety are measured, not claimed | J4 |
| US10 | Owner/staff | supply a rate card via a template | pricing reflects how I actually charge | J5 |
| US11 | Customer | be told the agent is automated when I ask | I am not deceived | J1 |
| US12 | System | treat discount and negotiation requests as refusals | the model never haggles | J2 |

---

## 6. Proposed Experience

**Design direction:** There is no UI in v0. The experience is a WhatsApp conversation, simulated. The mental model is a competent front-desk person who either quotes from the printed rate card or says "let me check with the owner", never guesses.

**Key states (conversation):**
- Quote reply: line-itemised price, validity (7 days), hold expiry (48h), tax line, terms.
- Missing-information reply: asks only for fields the rate card marks required; the rules report the gap, the LLM only phrases it.
- Refusal reply: honest holding message, date held if available, owner informed.
- Unavailable date: refusal-style reply with alternatives only if the card allows.
- Automated-assistant disclosure when asked directly.
- Error state: provider failure or low-confidence extraction → refuse or confirm back, never quote.
- Empty/first-contact state: greeting that states the business name and what the number can do.

**Primary flow:**
1. Inbound message hits the simulator/webhook.
2. Consent and thread state checked (owner takeover pauses the agent).
3. LLM extracts fields to strict JSON; schema validation; confidence gate.
4. Availability checked; hold created if open.
5. Kernel returns Quote or Refusal.
6. LLM words the reply; numbers injected by code, never generated.
7. Reply sent; ledger row appended with rate-card hash, model ID, region, cost.

**Accessibility notes:**
- Replies are plain text, short, one-handed readable on mobile data.
- Scripts in scope later: Latin, Devanagari, Perso-Arabic (RTL), Malayalam; PDF outputs must embed fonts covering them.

**Design link:** n/a for v0. `DESIGN.md` covers the marketing site only.

---

## 7. Component Inventory

No UI components in v0. Backend modules:

| Module | Type | Description | Stories |
|---|---|---|---|
| `kernel` (Rust) | Core | Rate-card parse, evaluate, Quote or Refusal, chain verify | US3, US4, US6 |
| `rules-language` | Core | Declarative pricing: units, packages, tiers, date classes, surcharges, tax, MOQ, required fields | US3, US10 |
| `extractor` | Service | Schema-constrained field extraction via `LlmProvider` | US1, US2 |
| `llm-provider` | Interface | `extract`, `word_reply`, later `transcribe`; Groq impl | US8 |
| `refusal` | Core | Typed reasons + holding reply + escalation stub | US4, US5, US12 |
| `ledger` | Service | Append-only, hash-chained, compensating entries | US6 |
| `availability` | Interface | Native table impl; Calendar impl later | US7 |
| `thread-state` | Service | State machine, takeover pause, consent | US1, US5 |
| `eval-harness` | Tooling | Labelled sets per language + adversarial set; per-model baselines | US9 |
| `wa-simulator` | Tooling | Replays recorded conversations | US1 |
| `payment-provider` | Interface | Razorpay / Stripe later; webhook is the only "collected" source | US6 |
| `rate-card-compiler` | Tooling | Template (Sheet later) → versioned, hashed rule file | US10 |

---

## 8. Data Models

```typescript
type Currency = "INR" | "AED" | "SAR" | string;   // ISO 4217
type Money = { amountMinor: number; currency: Currency }; // integer minor units only

interface Tenant {                // an organisation
  id: string; name: string; currency: Currency; timezone: string; // IANA
  createdAt: string;
}
interface Member {
  id: string; tenantId: string; role: "owner" | "manager" | "staff";
  phoneHash: string; phoneEnc: string;                     // encrypted at rest
}
interface Resource {              // hall, photographer, chair
  id: string; tenantId: string; locationId?: string; name: string;
}

interface RateCard {
  id: string; tenantId: string; version: number;
  contentHash: string;            // pinned in every quote
  source: { kind: "file" | "sheet"; ref: string; revisionId?: string };
  compiled: unknown;              // kernel input (opaque to TS)
  approvedAt?: string; approvedBy?: string;
  requiredFields: string[];       // drives clarification questions
}

interface Customer {
  id: string; tenantId: string; phoneHash: string; phoneEnc: string;
  language?: string; consent: ConsentEntry[];
}
interface ConsentEntry { at: string; kind: "first_reply" | "chase" | "marketing"; basis: string }

interface Thread {
  id: string; tenantId: string; customerId: string;
  state: "open" | "quoted" | "refused" | "paused_owner" | "booked" | "collected" | "closed";
  pausedUntil?: string;
}
interface ExtractedFields {       // LLM output; validated, never trusted
  service?: string; date?: string; guestCount?: number; locality?: string;
  language: string; confidence: number; raw?: never;       // free text never passed on
}

type Quote = {
  kind: "quote"; rateCardHash: string; total: Money; validUntil: string;
  lines: { label: string; amount: Money; ruleId: string }[];
};
type Refusal = {
  kind: "refusal";
  reason: "no_covering_rule" | "missing_required_field" | "date_unavailable"
        | "discount_request" | "low_confidence" | "out_of_policy" | "calendar_mismatch";
  ruleGap?: string; fields: Partial<ExtractedFields>;
};

interface Hold { id: string; resourceId: string; threadId: string; start: string; end: string; expiresAt: string }

interface LedgerEntry {           // append-only
  seq: number; tenantId: string; threadId: string; at: string;
  type: "enquiry" | "extraction" | "quote" | "refusal" | "hold" | "owner_message"
      | "payment_link" | "collected" | "chase" | "correction";
  payload: unknown; rateCardHash?: string;
  modelId?: string; provider?: string; region?: string; costMinor?: number;
  prevHash: string; hash: string; // hash chain
  corrects?: number;              // compensating entry reference
}
```

---

## 9. API / Integration Surface

v0 is library + CLI + test harness; no public HTTP. Planned surface for later phases:

| Method | Path | Description | Auth |
|---|---|---|---|
| POST | /webhooks/whatsapp | Cloud API inbound (verify signature) | Meta signature |
| POST | /webhooks/payments/:provider | Collected/failed events | Provider signature |
| GET | /ledger/:threadId/proof | Per-job proof for billing | Tenant member |
| POST | /rate-cards/:id/approve | Records approval after read-backs | Owner |

**Kernel interface (v0):** `evaluate(rateCard, ExtractedFields, availability) → Quote | Refusal`, pure and deterministic.

**Integrations (adapters, defined now):**
- `LlmProvider`: Groq now; AWS Bedrock later (Mumbai/UAE regions for residency)
- `PaymentProvider`: Razorpay (India), Stripe Payment Links (elsewhere); agent never holds funds
- `AvailabilityProvider`: native Postgres; Google Calendar (free/busy, tentative events, confirmed on payment)
- Rate-card source: file; Google Sheet (compiled snapshot, Drive revision pinned)
- Reporting mirror: Google Sheet, one-way, append-only
- Documents: Google Docs template → PDF via Drive; PDF hash in ledger
- Google auth: per-tenant OAuth, minimal scopes (Calendar events/free-busy, `drive.file`), encrypted tokens; domain-wide delegation optional later; verify current Google OAuth verification requirements before any real customer
- WhatsApp: Meta Cloud API direct; no BSP, no unofficial libraries
- Observability: OpenTelemetry; optional self-hosted Langfuse; no LangSmith

---

## 10. State Management Map

| State | Location | Persistence | Notes |
|---|---|---|---|
| Rate card (compiled) | Postgres | Persistent, versioned | Pinned by hash per quote |
| Thread state | Postgres | Persistent | State machine; owner message → `paused_owner` |
| Holds | Postgres | Persistent, auto-expire | Authority even when Calendar is used |
| Ledger | Postgres | Append-only | Triggers block UPDATE/DELETE |
| Timers (chase, hold expiry) | Postgres job queue | Persistent | Durable across restarts |
| Conversation context | Passed per call | None | LLM gets minimal fields, not history by default |
| Provider tokens | Postgres (encrypted) | Persistent | Per tenant |
| Eval baselines | Repo + DB | Persistent | Keyed by model ID + prompt hash |

---

## 11. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Kernel | Rust (WASM or napi) | Integer money, exhaustive enums make an uncovered quote unrepresentable |
| Orchestration | TypeScript | Fast iteration; matches existing repo |
| Web (later) | React Router v8 (framework mode) | Hosts site + webhooks + API; replaces Next 15.5 after kernel |
| Database | Postgres on Supabase, Mumbai (`ap-south-1`); Postgres 18 + Docker locally | RLS, durable queue, append-only triggers; India data residency. Used as plain Postgres: Supabase Data API disabled/locked, service connects directly via transaction-mode pooling, tenant ID set with `SET LOCAL` per transaction. No Supabase-specific features beyond Postgres (portable to AWS UAE/RDS later). |
| Auth | Better Auth + organization plugin (Drizzle adapter, any Postgres) | Maps to tenant → members → roles. Not Supabase Auth. Web login is rare: WhatsApp identity is the verified phone number mapped to a member; Better Auth covers admin/org-admin web sessions and Google connect. |
| Hosting (app) | Long-lived process (webhooks, timers); not serverless-only | Chase timers and hold expiry need a persistent worker. Host choice open. |
| Workflow | Plain state machine + Postgres timers | No LangGraph: flow is deterministic |
| LLM | Groq first behind `LlmProvider`; Bedrock later | Swappable, eval-gated |
| Tracing | OpenTelemetry (+ optional Langfuse self-hosted) | Keeps customer data out of third-party SaaS |
| Payments | Razorpay, Stripe via adapter | Region split |
| Tests | Rust unit/property tests; TS replay + eval suites | Determinism and safety are the product |

---

## 12. Suggested File Structure

```
enquiry-to-paid/
├── kernel/                     # Rust crate
│   ├── src/{lib,rules,evaluate,refusal,money,chain}.rs
│   └── tests/
├── agent/                      # TypeScript, no imports from site
│   ├── src/
│   │   ├── pipeline/           # state machine
│   │   ├── llm/                # LlmProvider, groq/, bedrock/ (later), fixtures/
│   │   ├── extract/
│   │   ├── ledger/
│   │   ├── availability/
│   │   ├── payments/           # interface only in v0
│   │   ├── google/             # interfaces only in v0
│   │   └── simulator/
│   ├── db/migrations/
│   └── eval/{sets,adversarial,baselines}/
├── rate-cards/                 # fictional examples, clearly labelled
├── prd/PRD.md
├── GLOSSARY.md
├── tickets/
└── src/                        # marketing site (unchanged in v0)
```

---

## 13. Acceptance Criteria

**US1 — Enquiry in, reply out**
- [x] Given a fictional English or Hinglish enquiry, the simulator produces exactly one reply: a quote, a clarifying question, or a refusal.
- [x] No reply contains a number not present in the kernel output.
- [x] Provider failure yields a safe holding reply and a ledger row, never a quote.

**US2 — Extraction**
- [x] Output validates against the schema or is rejected.
- [x] Customer text containing instructions ("ignore rules") never alters pipeline behaviour.
- [x] Confidence below threshold triggers confirm-back or refusal.

**US3 — Quote**
- [x] Same fields + same rate-card hash → byte-identical quote (1,000 replays).
- [x] Every line cites a `ruleId`; totals are integer minor units; tax is its own line.
- [x] Quote carries `validUntil` (default 7 days) and hold expiry (default 48h).
- [x] An expired quote is re-evaluated, not honoured.

**US4 — Refusal**
- [x] Any input without a covering rule returns a typed Refusal, never a number.
- [x] Property test: no generated input yields a Quote with a line lacking a rule.
- [x] The contractor card refuses the majority of its test enquiries.

**US5 — Escalation (stub)**
- [x] Refusal emits an escalation event with reason, rule gap and fields; delivery is a no-op interface in v0.

**US6 — Ledger**
- [x] UPDATE and DELETE on ledger rows fail at the database.
- [x] Hash chain verifies; altering a stored row makes verification fail.
- [x] Corrections are new entries referencing `corrects`.
- [x] Each quote row stores rate-card hash, model ID, provider, region, cost.

**US7 — Availability and holds**
- [x] A taken date never yields a quote.
- [x] Holds expire automatically and release the date.
- [ ] If a second availability source disagrees (later), result is refusal + escalation. *(scoped post-v0: no second source exists yet; see tickets/PRD-ACCEPTANCE.md)*

**US8 — Provider swap**
- [x] Groq and a fixture provider are interchangeable via config only.
- [x] A new provider/model cannot be enabled unless its eval meets or beats the recorded baseline per language.

**US9 — Evals**
- [x] Labelled English and Hinglish sets run in CI and publish per-language numbers, including poor ones.
- [x] Adversarial set covers prompt injection, price anchoring, discount demands, and out-of-card requests; target 0 quotes.

**US10 — Rate card**
- [x] A card compiles from the template or fails naming the exact cell/field.
- [x] Approval requires read-back worked examples; an unapproved card cannot quote.
- [x] Editing a source after approval has no effect until re-approved.

**US11 — Disclosure**
- [x] "Are you a bot / human?" in supported languages gets an honest automated-assistant answer.

**US12 — No negotiation**
- [x] Any discount or custom-deal request refuses with escalation; the model never proposes a price.

---

*Walked line by line against passing tests on 2026-11-10; see `tickets/PRD-ACCEPTANCE.md` for the file:line evidence behind every box.*

## 14. Open Questions & Risks

- **Risk:** no real owner interview yet; the rules language may not fit how a real banquet prices a December Saturday. *Mitigation:* run the hour before locking the schema; compiler isolates card format.
- **Risk:** revenue-share acceptance unvalidated. *Mitigation:* five owner conversations before any price page.
- **Risk:** Groq open-weight models may be weak on Hinglish/Arabic/Malayalam. *Mitigation:* eval gate, per-language publish, Bedrock/other provider swap.
- **Risk:** Rust toolchain/WASM friction. *Mitigation:* TS kernel fallback behind same interface; decide after first spike.
- **Risk:** no UAE region found at Supabase or Neon (checked Nov 2026; region pages were undated, re-verify live). *Mitigation:* plain-Postgres discipline so Gulf tenants can move to AWS UAE with dump/restore.
- **Risk:** Supabase Data API exposes tables by default; the ledger must never be reachable that way. *Mitigation:* disable/lock it and revoke anon/authenticated grants; test for it.
- **Risk:** Google OAuth app verification and scope reviews add lead time. *Mitigation:* ticket to check current requirements up front; test Workspace for v0.
- **Risk:** WhatsApp template approval, 24h window and opt-in rules constrain chasing. *Mitigation:* simulator first; template set designed early.
- **Risk:** voice-note ASR on Hinglish is weak. *Mitigation:* confidence gate; confirm-back; defer until text works.
- **Q:** exact hold duration, chase cadence and takeover idle timeout defaults (48h, 24h/72h, 12h). *Owner: product, validate with owners.*
- **Q:** small-team scope vs README "not the target: anyone with a sales team". *Owner: Kartikay; README/PRODUCT edit deferred.*
- **Q:** GCC payment provider (Stripe vs Tap/Telr) and Arabic dialect handling. *Owner: Kartikay, at first GCC customer.*
- **Tradeoff:** a Rust kernel costs setup time in exchange for structural safety on money.
- **Tradeoff:** native availability is authority even with Calendar, trading elegance for a single trustworthy source.

---

## 15. Rollout & Next Steps

**MVP (v0) includes:** kernel, refusal, ledger, extraction + evals, native availability, simulator, four fictional cards.
**Excludes:** live WhatsApp, payments, Google, owner interface, chasers, voice, site migration.

**Order of work:**
1. Kernel and rules language
2. Refusal path
3. Ledger
4. Extraction and eval harness
5. Availability
6. WhatsApp simulator
7. Payment adapters
8. Owner interface
9. Chasers
10. Google integrations
11. Real WhatsApp number
12. Site migration to React Router v8

**Production readiness stages (locked 2026-11-07):**
- **v0 (fictional data only):** local Postgres in Docker or one Supabase dev project; migrations in repo; CI runs lint, tests, offline evals and `ledger verify` on every push; no secrets in git; no real PII; logs never contain raw phone numbers.
- **Pilot (first real owner, real number):** separate staging and prod; managed Postgres in Mumbai with point-in-time recovery and a rehearsed restore; PII encrypted with key held outside the database; webhook signature verification, idempotency keys, replay protection; per-phone rate limits; PII-free error tracking and alerts; data-processing agreements with Supabase, Groq and Meta; retention and deletion policy; a global **kill switch** that puts the agent in refuse-everything mode; written incident runbook.
- **Paid (revenue share live):** disaster-recovery plan, access audit trail, independent security review, signed-off compliance review.

**Phase 2+:** voice-note transcription with confidence gate; Arabic, Urdu, Malayalam, Tagalog eval sets; Bedrock provider; conversational rate-card editor; org roles UI via WhatsApp; Langfuse viewer.

**Sign-off needed:**
- [ ] Kartikay (product + engineering)
- [ ] One real owner-operator (rate-card shape)
- [ ] Compliance review before any live number (`COMPLIANCE-PRIVATE.md`, not committed)

**Next steps:**
1. Write `GLOSSARY.md` and ordered `tickets/` from this PRD.
2. Install Rust; spike the kernel with one fictional card.
3. Schedule the owner interview hour.
4. Update README/PRODUCT "not the target" wording once confirmed.
