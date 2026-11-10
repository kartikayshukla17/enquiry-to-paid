# PRD §13 acceptance walk-through

Done 2026-11-10, against commit range through `c385c04` plus this walk's own fix. Every line below was checked against an actual running test, not inferred. File:line references are to `agent/` unless marked `kernel/`.

**Result: all 12 user stories pass. One criterion (US3's literal "1,000 replays") was under-tested at 100 and has been corrected as part of this walk** (`kernel/tests/evaluate.rs`, now asserts 1,000; `pnpm test` re-run green after the change, 741 agent tests + 94 kernel tests).

---

**US1 — Enquiry in, reply out**
- [x] Exactly one reply (quote / clarifying question / refusal): `src/pipeline/handle-message.test.ts` (quote, clarify, refusal cases), `src/simulator/contractor.test.ts`.
- [x] No reply contains a number absent from kernel output: wording is template-only with placeholders (`src/pipeline/reply.ts`); any stray price/digit/number-word/dropped or invented placeholder from the model falls back to the plain template — `handle-message.test.ts:159-179` (`it.each` over 5 stray-number/placeholder cases).
- [x] Provider failure -> safe holding reply + ledger row, never a quote: `handle-enquiry.ts:205-266` (`extractionFailure` gates identically to low confidence: `reason: "low_confidence"`, `ruleGap: "extraction_<code>"`, `holdingReply(...)`, an `extraction` ledger row always appended).

**US2 — Extraction**
- [x] Schema validation or rejection: `src/extract/schema.test.ts`.
- [x] Injected instructions never alter behaviour: adversarial suite (`pnpm adversarial`) — `prompt_injection` 6/6, `ignore_rules` 2/2, `hidden_field` 5/5, all refused/honest, 0 quotes issued.
- [x] Low confidence -> confirm-back or refusal: `handle-message.test.ts:127` ("low confidence below the threshold refuses..."), `:137` (exact-threshold boundary).

**US3 — Quote**
- [x] Byte-identical quote, same fields + same rate-card hash, 1,000 replays: `kernel/tests/evaluate.rs::identical_input_gives_byte_identical_output` — **raised from 100 to 1,000 in this walk** (runs in 0.54s). A second, end-to-end TS check (`src/simulator/run-fixture.test.ts:84`, DB-backed, 100 runs) covers the same property through the full pipeline; left at 100 there since it is a stronger, slower, non-PRD-named check, not the literal criterion.
- [x] Every line cites a `ruleId`, integer minor units, tax its own line: `kernel/tests/properties.rs::every_quote_line_has_a_known_rule_id_a_core_line_and_integer_totals`, `kernel/tests/evaluate.rs::prices_weekend_banquet_with_tax_as_its_own_line`.
- [x] `validUntil` (7d) / hold expiry (48h) defaults: shipped cards carry `validDays: 7`, `holdHours: 48` (e.g. `rate-cards/fictional-banquet.json`).
- [x] Expired quote re-evaluated, not honoured: `EXPIRED_QUOTE_PREFIX` in `src/pipeline/reply.ts:164`; `src/availability/pipeline-rules.test.ts:130` (price changed since expiry -> new price), `:157` (date taken since -> refusal, not old quote).

**US4 — Refusal**
- [x] No covering rule -> typed Refusal, never a number: `kernel/tests/evaluate.rs::no_matching_rule_is_a_typed_refusal`.
- [x] Property test, no Quote line lacking a rule: `kernel/tests/properties.rs` (same test as above, generator-driven).
- [x] Contractor card refuses the majority: eval output, `fictional-contractor` 64.3% refusal share (9/14).

**US5 — Escalation (stub)**
- [x] Every non-clarifying refusal notifies with reason, ruleGap, fields: `handle-enquiry.ts:136-145`; delivery is `createLogNotifier` (`src/escalation/index.ts`), a no-op/log stub as specified.

**US6 — Ledger**
- [x] UPDATE/DELETE/TRUNCATE blocked at the DB: `db/migrations/0002_ledger_hardening.sql` triggers; `src/ledger/ledger.test.ts:130` ("blocks UPDATE, DELETE and TRUNCATE").
- [x] Hash chain verifies; a tampered row fails verification: `ledger.test.ts:152,168,182,196`.
- [x] Corrections are new rows referencing the original: `ledger.test.ts:108,122`.
- [x] Rate-card hash, model, provider, region, cost on every quote row: `ledger.test.ts:81`; `handle-message.test.ts:64`.

**US7 — Availability and holds**
- [x] A taken date never yields a quote: `src/availability/availability.test.ts:58`, `never-quote-taken.test.ts`, `pipeline-rules.test.ts:157`.
- [x] Holds expire automatically and release the date: `availability.test.ts:88`, `holds-pipeline.test.ts:15` ("...49h later the hold is released and a third quotes").
- [ ] Second availability source disagreement -> refusal + escalation: explicitly scoped "(later)" in the PRD's own criterion text — no second source exists yet (Google Calendar is T21, post-v0). Not a v0 gap.

**US8 — Provider swap**
- [x] Groq/fixture interchangeable via config only: `LLM_PROVIDER` / `LLM_MODE` env, `src/llm/config.ts`.
- [x] A new provider/model cannot be enabled unless its eval meets or beats the baseline per language: `src/provider/gate.test.ts` (weak-model blocked, equal/better candidate passes, single-metric regression blocked even if better elsewhere, no-eval-path refused).

**US9 — Evals**
- [x] Labelled English/Hinglish sets run in CI and publish per-language numbers, including poor ones: `.github/workflows/ci.yml` (`pnpm run eval -- --check`); published numbers show Hinglish outcome accuracy 73.2% and 2 unsafe quotes, printed and committed, not hidden.
- [x] Adversarial set covers prompt injection, price anchoring, discount, out-of-card; target 0 quotes: `pnpm adversarial` output, all 10 categories, 50/50 refused or honest, quotes issued 0.

**US10 — Rate card**
- [x] Compiles from template or fails naming the exact cell/field: `src/ratecard/compile.test.ts` (deterministic hash, decimal-not-float money, named-cell errors), `kernel/tests/validate_card.rs` (duplicate rule IDs named by path).
- [x] Approval requires read-backs; unapproved card cannot quote: `src/ratecard/approve.test.ts:67,74`.
- [x] Editing the source after approval has no effect until re-approved: `approve.test.ts:110`.

**US11 — Disclosure**
- [x] Honest bot/human answer in supported languages: `src/pipeline/intent.test.ts:117` (English), `:130` (Hinglish, Devanagari for hi); adversarial `bot_question` 7/7 disclosures correct.

**US12 — No negotiation**
- [x] Discount/custom-deal requests refuse with escalation, model never proposes a price: `kernel/tests/evaluate.rs::discount_negotiation_and_package_intents_are_refused_whatever_else_is_present`; adversarial `discount` 4/4, `price_anchoring` 4/4, `package_deal` 3/3.

---

## What this does and doesn't mean
This confirms the v0 PRD's own acceptance bar is met by real, currently-passing tests — not that the product is complete. Known, already-published gaps stand as before: 2 unsafe quotes in the hand-seeded eval (en-09, hg-04), a 4-case Hindi eval set, banquet refusal share near the 50% generality line, and everything scoped out of v0 (payments, Google, real WhatsApp, owner UI, voice — T15 onward).
