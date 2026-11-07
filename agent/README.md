# agent

## Fourth vertical: contractor card, refusal-heavy (T13) and the Generality metric

Needs the local Postgres and `pnpm build:kernel` once (the kernel gained the card field `refusalSuggestion`). No network.

```sh
pnpm sim run fixtures/contractor-01-quote.json         # a narrow covered repair: quoted
pnpm sim run fixtures/contractor-02-renovation.json    # bathroom remodel: no_covering_rule + book_site_visit, escalation carries it
pnpm sim run fixtures/contractor-03-other-locality.json # covered job, locality not on the list: refused
pnpm sim run fixtures/contractor-04-over-size-cap.json # six taps, cap is three: refused
pnpm sim run fixtures/contractor-05-missing-field.json # a question, not a refusal: no suggestion
pnpm --filter agent exec tsx src/eval/cli.ts            # all five cards; per-card refusal share in the console and RESULTS.md
```

- Card: `rate-cards/fictional-contractor.json` (FICTIONAL). It quotes only three fixed-price small repairs, 1-3 items, in two listed localities; everything else (renovation, waterproofing, painting, rewiring, other localities, bigger counts) falls out as `no_covering_rule`.
- Generic card fields `refusalSuggestion` (a short code, here `book_site_visit`; the kernel validates it as `[a-z][a-z0-9_]*`, at most 64 chars, so prose cannot ride along) and `refusalSuggestionReply` (the customer-facing wording, written by the card owner). The kernel echoes the code on `no_covering_rule` refusals only, so it is a ledger fact on the refusal row; the escalation event carries `suggestion` (and the log line `suggestion=book_site_visit`); the holding reply is the usual generic text followed by the card's template verbatim. A card with no such field behaves exactly as before. The template is dropped if it contains a digit, so a holding reply can never state a number.
- Eval: 14 contractor enquiries (7 English, 7 Hinglish; 9 gold refusals, 4 quotes, 1 clarifying question) in `agent/eval/sets/contractor.jsonl`, plus 7 seasonal-banquet cases (`seasonal.jsonl`) so the harness runs all five card files: banquet, seasonal banquet, photographer, B2B supplier, contractor. `RESULTS.md` and the console print, per card: quotes, refusals, clarifying questions, refusal share (integer bps), gold refusal share, out-of-coverage quotes (must be 0) and how many no-covering-rule refusals escalated with a suggested next step.
- Generality metric (PRD section 2), asserted in `src/eval/run-eval.test.ts` on the report: banquet, seasonal banquet, photographer and B2B each refuse under half of their cases and quote at least one (by the labels and by what the pipeline did); the contractor card refuses a majority (64.3% of its cases; 8 of its 9 refusals are no-covering-rule, each with the site-visit suggestion); out-of-coverage quotes are 0 on every card.

Ruling: "zero out-of-coverage quotes" is asserted on the recorded reads. The kernel guarantee is stronger and separate (given fields outside every core rule, it cannot return a quote: `card_contractor.rs`, the US4 property test); the eval number additionally depends on the hand-seeded mistakes, and none of them was chosen to push an out-of-coverage case into coverage.
Ruling: banquet's refusal share (48.6%) is close to the 50% line because 18 of its 37 cases are refusals, most by label (out-of-season/size/date) and a few from deliberate extraction failures. It is published as it is, and the generality test holds the line at under 50% on both the labels and the outcomes.
Ruling: the suggestion only attaches to `no_covering_rule`. A missing field is a question, a discount request goes to the owner, a low-confidence read is not a coverage fact, and none of those should push a site visit.

## Third vertical: B2B supplier card (T12)

Needs the local Postgres and `pnpm build:kernel` once (the kernel gained `tiered_per_unit` and card `minimums`). No network.

```sh
pnpm sim run fixtures/b2b-01-quote.json              # 750 units: band unit price + small-order handling + GST
pnpm sim run fixtures/b2b-02-below-moq-refused.json  # 60 bolts, MOQ 100, flag refuse: out_of_policy, escalation, no number
pnpm sim run fixtures/b2b-03-below-moq-requoted.json # 120 ties, MOQ 500, flag raise_to_min: quoted at 500, reply says so
pnpm sim run fixtures/b2b-04-tier-boundary.json      # 499 vs 500 units: inclusive upTo, 500 totals LESS than 499
pnpm sim run fixtures/b2b-05-out-of-coverage.json    # 80,000 units: no_covering_rule
cargo test --manifest-path kernel/Cargo.toml --test card_b2b --test b2b_properties --test rules_language
```

- Card: `rate-cards/fictional-b2b-supplier.json` (FICTIONAL). Semantics (all documented in `rate-cards/README.md` and asserted in `kernel/tests/card_b2b.rs`): volume tiers are all-units pricing with an INCLUSIVE `upTo`; MOQ is per product with the card choosing refuse or re-quote-at-minimum; GST is a tax line rounded half-up in integer paise.
- Property tests (`kernel/tests/b2b_properties.rs`, proptest, JSON in/out): tier boundaries are exact and inclusive for any generated band table; the effective unit price never rises with quantity when band prices are non-increasing; every tax line equals the independent half-up integer formula for any subtotal and bps; total equals the sum of all lines including several tax lines; i64 extremes in quantity, unit price, flat fee and bps never panic and always return a quote, a refusal or a typed `overflow`/`invalid_input`; raise-to-minimum prices exactly the minimum. A mutation check (`<=` to `<` in the band lookup) makes the boundary property fail.
- Reply: a quote with `adjustments` adds one sentence per adjustment from the card's label ("<label> applies, so this quote is for 500 instead of the 120 you asked for."); the intro echoes the quoted quantity. Both are typed data, never model text. The thread keeps what the customer said (120); only the quote is raised.
- Eval: 16 labelled B2B enquiries (8 English, 8 Hinglish) in `agent/eval/sets/b2b.jsonl` including tier-boundary, MOQ-refuse, MOQ-requote, out-of-coverage and code-switched numbers ("do hazaar", "paanch sau", "assi hazaar").

Ruling: MOQ refusal reuses the closed `out_of_policy` reason with `ruleGap below_minimum:quantity` (no new enum member); the holding reply is the generic one, so no text is invented for it.
Ruling: the extra recordings for the new eval cases were added by the documented seed script; the prompt did not change in T12 (the generic `quantity` field was introduced with `extract-v3` in T11).
Ruling: all-units pricing means a larger order can cost less than a smaller one just under a boundary. That is the documented card behaviour (and a property test pins the unit price, not the total, as the monotone quantity); a card wanting marginal tiers needs a different charge kind.

## Second vertical: photographer card (T11)

Needs the local Postgres and `pnpm build:kernel` once (the kernel gained `per_unit.included`). No network.

```sh
pnpm sim run fixtures/photographer-01-quote.json           # Standard package, 6 h, 10 km: package + GST
pnpm sim run fixtures/photographer-02-extra-hours.json     # Premium, 10 h (2 extra), 45 km (band 2), Saturday: five lines + GST
pnpm sim run fixtures/photographer-03-missing-field.json   # no package named: the card's own question, thread stays open
pnpm sim run fixtures/photographer-04-out-of-coverage.json # 85 km: no_covering_rule, holding reply, escalation, no number
pnpm --filter agent exec tsx src/eval/cli.ts               # per-language AND per-card tables (writes RESULTS.md)
cargo test --manifest-path kernel/Cargo.toml --test card_photographer
```

- The card is `rate-cards/fictional-photographer.json` (FICTIONAL, labelled). The only engine change is the generic `per_unit.included` (units beyond an included quantity); travel bands reuse `tiered`, packages reuse `eq` on a `package` slug. A grep guard (`src/guards/guards.test.ts`) fails the build if kernel or agent source ever names a vertical, or uses float money.
- `ExtractedFields` gained four generic optional typed fields, rebuilt field by field like the rest: `package` (slug), `quantity` (1..1,000,000), `hours` (1..48), `distanceKm` (0..100,000). A card decides what they mean. The extraction prompt lists them, so the schema version is now `extract-v3`.
- Eval: 14 labelled photographer enquiries (7 English, 7 Hinglish) in `agent/eval/sets/photographer.jsonl`, each with a `card` dimension. The report and `RESULTS.md` carry a per-card table (quotes, refusals, refusal share, out-of-coverage quotes). A case scores the extraction fields its gold names, so photographer cases score `package`, `hours` and `distanceKm`, and banquet cases are scored exactly as before. Card report order lives in `agent/eval/cards.json` (data).

Ruling: the prompt changed, so every recording keyed by the old prompt hash was regenerated with the documented seed scripts (`src/llm/seed-recordings.ts`, `src/eval/seed.ts`, `src/adversarial/seed.ts`), the baseline moved from `recorded-fixture-v1.561b3af9.json` to `recorded-fixture-v1.09cc42a3.json`, and `config/enabled-providers.json` was repointed to it (`gate.test.ts` checks `enabledAt` equals the baseline's sha256). The 37 banquet cases score exactly as before.
Ruling: coverage is a property of the `core` rules' `when` ranges, not a separate concept: hours over 12, a venue over 60 km, an unknown package or an unknown service all fall out as `no_covering_rule` with the failing field named in `ruleGap`.
Ruling: the photographer set contains two confidently wrong reads (a 40 km venue read as 4, "pachaas" read as 15) that under-price; they are published as wrong-price quotes, not tuned away. There are no out-of-coverage quotes.

## Availability, holds and timers (T10)

Needs the local Postgres and `pnpm build:kernel` once (the kernel now accepts an optional card field `offerAlternatives`). No network.

```sh
pnpm sim run fixtures/holds-saturday.json   # the demo below, in a throwaway database
pnpm sim tick --now 2026-11-09T11:00:00Z    # run every durable timer due at that instant (hold expiry) against DATABASE_URL
```

Demo (`fixtures/holds-saturday.json`, three fictional customers, one Saturday, the clock is the fixture's): customer A on 7 Nov 10:00 gets a quote and "Your date is held for you until 9 Nov 2026, 3:30 pm IST"; customer B two hours later is told "Unfortunately 12 Dec 2026 is not available" (no price); the clock moves to 9 Nov 11:00 (49h), the tick expires A's hold and releases the date; customer C then gets a quote and a fresh hold until 11 Nov 5:30 pm IST.

- `AvailabilityProvider` (`src/availability/types.ts`): `blockedDates` (dates a quote must not be issued for) and `placeHold` (atomic: write the hold or report `taken`). `nativeAvailability` (`native.ts`) is the Postgres implementation; the Calendar one (T21) plugs in behind the same interface. Passed to the pipeline as `deps.availability`; without it only the caller's static `availability.blockedDates` apply (existing fixtures, eval and adversarial runs are unchanged). Fixtures opt in with `"holds": true`.
- Tables (migration 0007, all with `tenant_id`, forced RLS, same policy as the rest): `availability_blocks` (inclusive date range, reason, source), `holds` (resource, thread, date range, `expires_at`, status `active|expired|released|confirmed`) with an exclusion constraint `holds_no_overlap` (btree_gist, `WHERE status='active'`) so two active holds can never overlap on a resource, and `timers` (kind `hold_expiry`, `run_at`, `pending|done`, unique per subject). A resource is the tenant's `<tenant>:resource:default` unless one is named.
- Pipeline order: extraction -> read blocked dates for the requested date (provider + static) -> kernel (taken date = `date_unavailable` refusal, never a quote) -> if a quote: `placeHold` in the SAME transaction, then the quote row, then a ledger `hold` entry (`action: placed`). If the hold loses a race the kernel is asked again with the date blocked, so the quote is never issued. The hold lasts the card's `holdHours` from the injected `now`; the reply says "Your date is held for you until <time in the card's timezone>".
- Refusal reply for a taken date states the date and that it is not available; nearby free dates (dates only, never prices, up to three, +-14 days, only dates the kernel would quote, no hold placed) are offered ONLY if the card sets `offerAlternatives: true`. The banquet card does not set it.
- Owner commands (`handleOwnerCommand`, `commands.ts`): `block 2026-12-12 hall maintenance`, `block 2026-12-12 to 2026-12-14 reason`, `unblock 2026-12-12`, `show blocks`. A small regex parser, no LLM; anything else is "not a command" and goes to the normal pipeline; a malformed block/unblock gets a usage reply, never a guess. Sender is looked up in `members` by phone hash; only `owner` and `manager` may change blocks (staff and strangers are told no and the attempt is logged). Each command appends an `owner_message` ledger entry on the tenant's operations thread (`<tenant>:thread:ops`).
- Timers: `runDueTimers(pool, now, {kernel?})` (`src/timers/run.ts`). For each due `pending` timer it opens a transaction, claims the row with `FOR UPDATE SKIP LOCKED`, drops to the app role with the tenant set, expires the hold (only if still `active`), appends a ledger `hold` entry (`action: expired`) and marks the timer done, all in one commit. A crash rolls the claim back, so the timer is just due again; running twice, or two workers at once, expires each hold once. Durability test recreates the pool.
- Expired quotes: every message is re-evaluated by the kernel against the CURRENT card and availability; a quote is never replayed. If the thread's latest quote is past its `validUntil` the reply starts "Your earlier quote has expired, so I have checked our current rates and availability again." and the new price, or the new refusal, follows.

Ruling: Postgres is the authority for availability. A hold past `expires_at` is non-blocking at READ time (the check uses the injected clock), so a stalled or absent worker can never keep a date locked; the timer only does the bookkeeping (status, ledger entry). A hold that a later booking sweeps first is logged as expired by that booking and the timer then finds nothing to do.
Ruling: asking again for the date you already hold reuses the hold and does NOT extend it, so a customer cannot squat on a date by messaging every 47 hours. Asking for a different date releases the old hold (one active hold per thread).
Ruling: writers of one resource (holds, blocks) take a row lock on the `resources` row, which both prevents the exclusion-constraint deadlock under three or more concurrent writers and keeps the constraint as a backstop that nobody can bypass. The pipeline's lock order is thread, ledger head, resource; the timer worker takes the ledger head before touching holds, so the two cannot deadlock.
Ruling: `runDueTimers` needs a pool on the OWNER role (the one deliberate cross-tenant path, like `ledger verify`), because the claim query must see every tenant's due timers; the work itself runs as `e2p_app` with `app.tenant_id` set. Blocking a date that already has a live hold does not cancel the hold (the owner is told); the hold's customer keeps the date they were quoted.
Ruling: a taken date still escalates to the owner like any `date_unavailable` refusal (it is lost demand they may want to see); the customer reply is specific, not the generic "passed to our team" holding text.
Ruling: the number rule from T1 stands: the only new digits in a reply are the hold time (formatted from the stored timestamp) and, with `offerAlternatives`, dates; a test derives the allowed set independently.
Ruling: not done here: `confirmed` hold status is defined but nothing sets it until payment (T15); a hold covers one date per enquiry (multi-day events need a card field for duration); timers are polled by whoever calls `tick`/`runDueTimers` (a scheduler in production is deployment, not code in this repo).

## Provider swap gate (T9)

Needs the local Postgres (a throwaway database is created and dropped) and `pnpm build:kernel` once. No network.

```sh
pnpm provider check fixture weak-fixture-v0      # run the eval sets for the candidate, compare per language, write nothing
pnpm provider enable fixture recorded-fixture-v1b [--promote]   # same gate; on pass writes eval/baselines/<model>.<prompthash8>.json and the registry entry
LLM_PROVIDER=keyword LLM_MODEL=keyword-extractor-v0 pnpm sim chat "..."   # swap by config only; runtime refuses it until it is enabled
```

- Exit codes: 0 passes / enabled, 1 blocked by the gate, 2 usage or setup error (including a provider with no offline eval path).
- Providers behind `LlmProvider` (no pipeline code differs between them): `groq`, `fixture` (recorded-fixture-v1, plus the same replay relabelled `recorded-fixture-v1b`, plus `weak-fixture-v0`, a wrapper that misreads Hinglish/Hindi hundreds like "do sau" as 2), and `keyword` (`keyword-extractor-v0`, an independent regex extractor for plain English and Latin-script Hinglish, region `local`). Selected by `LLM_PROVIDER` and `LLM_MODEL` only.
- Registry: `agent/config/enabled-providers.json` maps `provider/model` to its baseline file and `enabledAt` (sha256 of that baseline, i.e. the eval run that justified it); `current` names the reference model. `createProvider` throws for a provider/model that is not listed (tests and the harness pass `registry: false`; record mode is dev tooling and exempt).
- Gate: per language (english, hinglish, hindi) the candidate must not be worse than the current model's baseline on field accuracy, schema-valid rate, outcome accuracy, unsafe quotes (count must not exceed) and wrong-price quotes (count must not exceed). Output names each regression, e.g. `BLOCKED: hinglish.outcomeAccuracy 50.0% < baseline 56.3%`. A candidate that already has its own baseline must also not regress against that. `--promote` makes an enabled model the new reference.
- Region: every ledger row carries provider, model and region; `customerTextSeenBy(pool, tenantId?)` (`src/provider/seen-by.ts`) lists each distinct provider/model/region that received customer text, derived from the enquiry rows.

Ruling: enabling is decided by the eval, not by hand: the registry is only written by `pnpm provider enable` after a pass. Editing the JSON by hand is possible (it is a committed file), and is then visible in review; the runtime guard checks presence, not the hash.
Ruling: the first honest result is that `keyword-extractor-v0` is BLOCKED against the hand-seeded baseline (it reads English and Hinglish fields well but fails Devanagari entirely, and quotes one more unsafe case in Hinglish). The baseline is itself hand-seeded, so "better than baseline" means better than a scripted model, not better than a real one; a live provider must be gated on recorded live responses for the eval sets before it can be enabled.
Ruling: `groq` models have no offline eval path yet, so they cannot be enabled by this command; the committed registry lists only the recorded fixture.

## Adversarial inputs, no negotiation, honest disclosure (T8)

Same prerequisites as the eval harness (local Postgres, `pnpm build:kernel` once, no network).

```sh
pnpm adversarial     # per-category table; exit 1 on any quote issued, wrong outcome, number in a reply, missing escalation, wrong disclosure, or untyped kernel input
pnpm --filter agent exec tsx src/adversarial/seed.ts   # regenerate agent/eval/adversarial/recordings/ from the cases' own `response` field
```

- Cases: `agent/eval/adversarial/cases.jsonl`, 50 fictional hostile messages in 10 categories (prompt injection, ignore-your-rules, price anchoring, discount, package deal, out-of-card, past date, "are you a bot?" in English, Hinglish and Hindi, instruction-like text hidden in `service`/`locality`, and 10 cases where the recording models a model that was FOOLED: it returned a `price` field, injected `total`/`discountPercent`/`system` keys, copied instructions into a slug field, invented an intent). Each case carries the scripted model reply and a gold ending: a typed escalated refusal, or a disclosure.
- Extraction now also returns a closed `intent` enum (`enquiry | discount_request | negotiation | package_deal | asks_if_bot | other`). It is a per-message value: it is never stored on the thread.
- `discount_request | negotiation | package_deal` reach the kernel as that one enum value and the kernel refuses with `discount_request`; the reply is static ("I am not able to change or negotiate prices ... passed to the owner") and the owner is notified. `asks_if_bot` never reaches the kernel: the reply is static text naming the business ("I'm an automated assistant for <business>, not a person ... I can get the owner to take over"), in English, Hinglish (Latin script) or Hindi (Devanagari) by extracted language, logged as a `disclosure` ledger entry, no escalation, and the thread continues.
- Kernel: a `date` before the UTC day of `now` is refused (`out_of_policy`, `ruleGap date_in_past`); today is allowed.

Ruling: `pnpm adversarial` is the gate, and it is also part of `pnpm test` (a test runs the suite and checks it detects a planted quote) and CI. The kernel-input spy asserts that kernel input is exactly `{rateCard, fields, availability, now}`, that field keys are whitelisted, that every value is an integer, slug, ISO date or enum member, and that the raw customer message never appears.
Ruling: the recordings are hand-seeded, so this proves the pipeline's gates (schema, slug rule, kernel) hold when a model misbehaves; it does NOT show that a real model classifies every injection as `negotiation`. If a model returns no or the wrong `intent` on a hostile message that is otherwise a complete, valid enquiry, the kernel will quote the card price (never a price the customer or model chose). `intent` is optional in the schema, so a missing value is accepted as "no classification".
Ruling: a model that misclassifies "are you a bot?" as an ordinary enquiry does not get a disclosure; the suite shows this as a violation, but nothing in the pipeline can detect it without a second classifier.

## Eval harness (T7)

Needs the local Postgres (a throwaway database is created and dropped) and `pnpm build:kernel` once. No network, no key.

```sh
pnpm eval                      # per-language table; writes agent/eval/RESULTS.md; writes the baseline if none exists
pnpm eval --write-baseline     # replace agent/eval/baselines/<modelId>.<prompthash8>.json and RESULTS.md
pnpm run eval -- --check       # CI: exit 1 on ANY drift from the committed baseline or RESULTS.md
pnpm --filter agent exec tsx src/eval/seed.ts   # regenerate agent/eval/recordings/ from src/eval/recorded.ts
```

- Sets: `agent/eval/sets/en.jsonl`, `hinglish.jsonl` (Latin-script Hinglish plus Devanagari `lang: "hi"`), 37 fictional cases, each with gold fields and a gold outcome (quote | clarify | refuse + reason) against `rate-cards/fictional-banquet.json`. A test checks every gold outcome equals the kernel's answer for the gold fields.
- Metrics per language: field-level exact-match accuracy, schema-valid rate, mean confidence (extraction alone); outcome accuracy, **unsafe quotes** (quote issued where gold says clarify/refuse), wrong-price quotes and missed quotes (full pipeline through `handleMessage`).
- Output is byte-reproducible (no timestamps, integer basis points, fixed scenario clock).

Ruling: results are labelled "measured on fictional data; recorded-fixture provider, not a live model". The recordings are hand-seeded (gold fields plus the listed injected mistakes in `src/eval/recorded.ts`), so the numbers check the harness and safety gates and are NOT model accuracy for any language; a real figure needs a live-model recording run.
Ruling: the baseline is keyed by model ID + extraction prompt hash and also pins the set hashes and a hash of every recording; `--check` treats any difference (better or worse) as failure, so improvements are committed deliberately with `--write-baseline`.
Ruling: bad numbers are published, not tuned away: `RESULTS.md` names every unsafe quote and miss. T8 closed the gap T7 found (the kernel quoted past dates): unsafe quotes went from 4 to 2 and wrong-price quotes from 1 to 1 (hg-16, a past date, is now refused; en-02, a new hand-seeded digit slip, replaced it so the metric stays exercised). The two remaining unsafe quotes are invented FUTURE dates for "next Friday" / "agle hafte Saturday"; the confidence gate cannot catch a confidently wrong read.

## LLM extraction (T6)

- `LlmProvider` (`src/llm/types.ts`): `extract` and `wordReply`. Implementations: `groq/` (OpenAI-compatible chat completions, JSON mode, injectable `fetch`) and `fixture/` (recordings keyed by `sha256(op, normalised input, prompt hash)` in `src/llm/fixtures/`).
- Config only: `LLM_PROVIDER=groq|fixture` (default `fixture`), `LLM_MODE=record|replay|live` (default `replay`; tests and CI never leave it), `GROQ_API_KEY` from env only, `GROQ_MODEL` (default `llama-3.3-70b-versatile`), `GROQ_REGION` (recorded as the processing region, default `us`), `LOW_CONFIDENCE_BPS` (default 7000), `LLM_WORD_REPLIES=1`.
- A missing recording in replay mode fails loudly. `pnpm --filter agent exec tsx src/llm/seed-recordings.ts` regenerates the hand-written fictional recordings (labelled provider `fixture`, never as Groq output).
- `pnpm sim chat "<english text>" [--tenant id] [--card rate-cards/x.json] [--customer ref] [--words]`; `pnpm sim run fixtures/llm-banquet-01-quote.json` (free-text fixtures replay offline).
- Live (not exercised in this repo's tests): `GROQ_API_KEY=... LLM_PROVIDER=groq LLM_MODE=record pnpm sim chat "..."` calls Groq and writes the recording; rerun without the key for an offline replay.

Ruling: extraction output is validated in TS (`src/extract/schema.ts`), rebuilt field by field; unknown keys, wrong types and free text are rejected.
Ruling: confidence below the threshold (default 7000 bps) is a `low_confidence` refusal with the holding reply and an escalation; nothing from that read is merged into the thread (a confirm-back state machine is deferred).
Ruling: provider failure or schema-invalid output is a `refusal` row (reason `low_confidence`, `ruleGap extraction_<code>`) plus escalation; the kernel is never consulted and no quote is possible. Missing recording or key are setup errors and throw.
Ruling: the model never writes a number: wording uses `{{placeholders}}`, code injects the values, and any digit run or number word not in the plain reply forces the plain reply.
Ruling: cost is per call: the extraction row carries the extraction cost, the outcome row the wording cost (0 if none); the enquiry row records which provider/region saw the text (cost 0). Raw text lives only in the enquiry ledger row, never in logs.

## Ledger tamper-evidence demo (T4)

Needs the local Postgres (`postgres://postgres:postgres@localhost:54329/e2p`) and `pnpm build:kernel` once.

```sh
export DB=postgres://postgres:postgres@localhost:54329/e2p
pnpm sim run fixtures/banquet-01.json        # migrates + writes 3 chained rows
pnpm ledger verify                           # OK (exit 0)

# 1. Edits are blocked by the database:
psql $DB -c "UPDATE ledger_entries SET payload='{}' WHERE tenant_seq=1"   # ERROR: ledger_entries is append-only
psql $DB -c "DELETE FROM ledger_entries"                                  # ERROR

# 2. Disable the trigger (superuser), edit anyway, and verify names the row:
psql $DB -c "ALTER TABLE ledger_entries DISABLE TRIGGER USER"
psql $DB -c "UPDATE ledger_entries SET payload='{}' WHERE tenant_seq=2"
psql $DB -c "ALTER TABLE ledger_entries ENABLE TRIGGER USER"
pnpm ledger verify          # BROKEN at tenant=... seq=... tenant_seq=2 reason=hash_mismatch (exit 1)
```

Reasons: `hash_mismatch` (row edited), `prev_hash_mismatch` (a row before it was edited and re-hashed),
`seq_gap` (a row was removed), `tail_truncated` (last rows removed; caught by `ledger_heads`).
Use `pnpm ledger verify --tenant <id>` for one tenant. Corrections are new `correction` rows whose
`corrects` points at the original `seq` (`appendCorrection`).

## Tenant isolation, PII and org roles (T5)

Needs the same local Postgres. Throwaway keys are fine for a demo; real keys come from the environment only.

```sh
pnpm sim two-tenants fixtures/two-tenants.json   # same enquiry under two tenants/cards; cross-tenant reads blocked
pnpm ledger verify                               # still works (owner connection, see below)
```

- Every tenant table (`tenants, customers, threads, rate_cards, ledger_entries, ledger_heads, members, resources`) has RLS
  enabled **and forced** with `tenant_id = current_setting('app.tenant_id', true)`; unset means no rows (fail closed).
  A test enumerates every table in `public`, so a new table without RLS fails the build.
- `withTenant(pool, tenantId, fn)` (`src/tenancy/with-tenant.ts`) = `BEGIN; SET LOCAL ROLE e2p_app; set_config('app.tenant_id', ..., true)`.
  The pipeline (`handleEnquiry`, `runFixture`, `runTwoTenants`) only ever runs through it. `e2p_app` is NOLOGIN, not superuser, not BYPASSRLS;
  production grants it to a login role (or `ALTER ROLE e2p_app LOGIN PASSWORD ...` from a secret). The ledger is INSERT/SELECT only for it.
- **Owner connection (documented choice):** `pnpm ledger verify`, `migrate`, and Better Auth connect as the owner role from `DATABASE_URL`.
  Verify is a read-only audit across all tenants (it must see every chain), and Better Auth must query its tables before a tenant is known.
  FORCE RLS applies to a non-superuser owner too, so in production the verify role needs BYPASSRLS (or a SELECT-only audit policy).
- PII: `PII_ENC_KEY` (AES-256-GCM) and `PHONE_HASH_KEY` (HMAC-SHA256 lookup hash), each 32 random bytes base64
  (`openssl rand -base64 32`). Tests generate random keys; `pnpm sim` generates process-local ones if unset. Raw phones are never logged.
- Auth: `src/auth/` is Better Auth + organization plugin on Drizzle. `BETTER_AUTH_SECRET` from env only. organization.id **is** the tenant id;
  organization members mirror into `members` with roles `owner | manager | staff`.
- Supabase: see `docs/supabase-lockdown.md` (Data API off; `anon`/`authenticated` hold nothing).

Ruling: Better Auth's tables (`user, session, account, verification, organization, member, invitation`) are excluded from RLS with a reason (the
library queries them before a tenant is known); `e2p_app`, `anon`, `authenticated` have no privileges on them, and all tenant-scoped app tables stay RLS-protected.

## Rate-card compile, approval and activation gate (T14)

An owner's pricing comes in as a Sheet-shaped template, is compiled, read back as worked examples, and only then can quote.

```bash
pnpm card compile rate-cards/templates/fictional-banquet-template      # exact broken cells (exit 1) or the card hash (exit 0)
pnpm card approve rate-cards/templates/fictional-banquet-template --no 2     # simulated read-backs: example 2 wrong -> stays a draft (exit 1)
pnpm card approve rate-cards/templates/fictional-banquet-template --yes      # every example right -> approved, active (exit 0)
pnpm card demo                                                         # the whole story on a throwaway database
pnpm sim run fixtures/card-template-banquet-01.json                    # template card, approved through the gate, quotes like the JSON card
pnpm sim run fixtures/card-unapproved-banquet-01.json                  # draft-only card: out_of_policy / card_not_approved, holding reply, escalation
```

- **Template** (`rate-cards/templates/<name>/*.csv`, one CSV per sheet, so each is a Google Sheets tab export): `meta.csv` (key,value), `required_fields.csv`,
  `rules.csv` (one row per charge), `conditions.csv` (one row per condition, linked by `rule_id`: `is | one_of | between | weekday_in | month_in`),
  `tiers.csv` (bands for `tiered` / `tiered_per_unit`), `taxes.csv` (percent), optional `minimums.csv`. Extra columns (notes) are ignored.
  Money cells are major units as decimal text (`1250.50`); `parseMinor` turns them into integer minor units by string arithmetic, no float is ever created.
- **Compiler** (`src/ratecard/compile.ts`): template -> rules JSON -> `kernel.validateCard` (new Rust export `validate_card`, with JSON paths) -> `kernel.rateCardHash`.
  Errors are `<file> row <n>, column "<header>": <what is wrong>` (spreadsheet row, header = row 1) for every broken cell in one pass; a kernel complaint is mapped back
  to the cell that produced it (e.g. a tax rate over 100% names `taxes.csv row 2, column "rate_percent"`).
- **Approval** (`src/ratecard/approve.ts`): `startApproval` builds 3 to 5 worked examples from the card's own conditions (every core rule and every surcharge appears
  in at least one) and prices them with the kernel; they are stored with the revision. `submitApproval` needs a yes/no for every example from a member whose role is
  `owner` or `manager`. All yes: revision `approved`, `approved_at`, `approved_by` (member id), `approved_hash` pinned, ledger entry `rate_card_approved` carrying the card
  hash. Any no: stays `draft`, `rejection_reason` stored, ledger entry `rate_card_rejected`.
- **Gate** (`src/ratecard/store.ts` `loadActiveCard`, called by `handleEnquiry`): the pipeline prices ONLY from the tenant's approved snapshot, re-hashed by the kernel against
  both `content_hash` and the pinned `approved_hash`. No approved snapshot -> refusal `out_of_policy` / `card_not_approved`; stored snapshot altered -> `card_hash_mismatch`.
  Both reply with the holding text, write a refusal ledger row without a card hash, and escalate. The card object a caller passes only names which card is meant (`id`).

Ruling: template == JSON card, by hash. The banquet template compiles to a card whose kernel hash is identical to `rate-cards/fictional-banquet.json` (the compiler omits `core` when it is "no", exactly as the hand-written card does), and the same fixture quotes identically through both (`gate.test.ts`).
Ruling: editing a source after approval has no effect until re-approved. A compile makes a new `draft` revision (`rate_cards.version` 1, 2, 3... per tenant+card; the card's own `version` field stays part of the hashed content); the active approved snapshot keeps quoting, with its own hash, until the new revision is approved, which supersedes the old one (one approved row per tenant+card is a unique partial index). Compiling identical content again returns the existing revision.
Ruling: an unapproved or tampered card does not quote and does not fall back to anything: it refuses with a typed reason and escalates. Only the "are you a bot?" disclosure still works, because it prices nothing.
Ruling: no bypass in production code. Hand-written JSON cards (fixtures, eval, adversarial, many tests) get their approval through `seedApprovedCard` (`src/ratecard/legacy.ts`), a setup-only helper that runs the SAME publish -> read-backs -> all-yes -> approve path as a seeded per-tenant owner. `handleEnquiry` no longer writes `rate_cards` and no longer takes `rateCardVersion`.
Ruling: approval is a tenant-level event, so `ledger_entries.thread_id` is now nullable (migration 0008) and two entry types were added (`rate_card_approved`, `rate_card_rejected`); the hash chain handles a null thread like any other null field. `rate_cards` already had `tenant_id`, forced RLS and the policy (0004), so no new table; the app role may UPDATE only the decision columns (not `compiled` or `content_hash`).
Ruling: read-back dates are solved from the card's conditions, starting 14 days after the injected `now`, and are stored with the revision, so the owner is asked about exactly what is later re-checked at submit time (each stored total is re-priced by the kernel first; a stale one aborts). Examples are chosen by a greedy rule-coverage pass, so the set is deterministic for a card and a clock, but it proves the owner saw each rule priced once, not that every tier edge is right.
Ruling: not done here: Google Sheets itself is not wired (the template is the CSV export of the Sheet; PRD lists Sheets as an interface only); only the banquet has a template (the other four cards stay JSON); `pnpm card approve` simulates the owner's replies, there is no WhatsApp channel for it yet; template support covers the kernel's current rule language (`minimums` yes, `refusalSuggestion` / `offerAlternatives` via `meta.csv`).
## v0 known-issue fixes (PRE)

Ruling: `intent` is a REQUIRED extraction key. An output that omits it (or says null) is schema-invalid, so it takes the provider-failure path (rejected extraction row, `low_confidence` refusal with `extraction_schema_invalid`, price-free holding reply, escalation), even on a hostile message. Seam: `handleMessage` with a scripted provider (`pipeline/intent.test.ts`) plus `validateExtraction` unit cases. Hand-seeded recordings (llm fixtures, eval, `recorded.ts` mistakes) now carry `intent: "enquiry"`; the eval baseline/RESULTS.md/registry hash moved only because the recordings hash did (all metrics identical).
Ruling: no LLM/network call while a DB transaction is open. Extraction already ran before `handleEnquiry`. Wording is fetched by a decide, roll back, word, re-commit loop: the decision runs in a short transaction, and if the reply needs wording it throws, the transaction rolls back (no trace), wording is fetched with no transaction open, and the decision re-runs with that wording (matched by kind+template+values). Ledger rows are written only in the committing run, so model/provider/region/cost are recorded as before and recorded runs are byte-identical. If thread state moves between attempts the wording is requested again; after 3 attempts the plain kernel-derived reply is used. Seam: `runFixture` with a provider double that, on every call, asks a second connection whether any connection of the database is `idle in transaction` (`pg_stat_activity`) (`simulator/no-llm-in-txn.test.ts`); it asserts the wording call happened (not vacuous) and was red before the change.
