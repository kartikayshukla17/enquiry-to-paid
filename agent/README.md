# agent

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
