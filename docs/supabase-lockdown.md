# Supabase lockdown: the Data API stays off

Enquiry to Paid talks to Postgres only through the agent, over a direct pooled connection, as the
`e2p_app` role with `SET LOCAL app.tenant_id` per transaction. Supabase's auto-generated REST/GraphQL
layer (PostgREST, the "Data API") is a second, unreviewed door into the same tables, so it is disabled
and the database is also locked down so that it would not help even if someone turned it on.

## Turn it off (hosted Supabase)

1. Dashboard, Project Settings, Data API (older UI: API): switch off **Enable Data API**.
2. Under Project Settings, API, leave **Exposed schemas** empty (remove `public`).
3. Do not run `supabase start` with `[api] enabled = true` in `supabase/config.toml`; this repo ships no such file and a test fails if one enables it.
4. Connect the agent with the direct (session/pooled) connection string, never the transaction-mode pooler, because RLS relies on `SET LOCAL` inside a transaction.

## Defence in depth (migration 0004, tested)

- `anon` and `authenticated` are created if absent and have no privilege on any table or sequence, and no `USAGE` on schema `public`.
- Default privileges are revoked, so tables added later are not auto-granted to them.
- Every tenant-scoped table has RLS enabled and forced; a test enumerates all public tables so a new one cannot be forgotten.

## Which connection does what

- Pipeline (`handleEnquiry`, `runFixture`): `withTenant()` runs `SET LOCAL ROLE e2p_app` + `SET LOCAL app.tenant_id`.
- `pnpm ledger verify` and Better Auth: connect as the owner role (`DATABASE_URL`). Verify is a read-only cross-tenant audit; the auth library manages its own tables. Neither is exposed to customers.
