-- 0004: tenant isolation (T5). Row-level security on every tenant-scoped table, an unprivileged app role,
-- members/resources, PII columns, and a lockdown of the Supabase-style Data API roles.
--
-- Tenant ids are text in this schema, so the policy compares text:
--   tenant_id = current_setting('app.tenant_id', true)
-- When app.tenant_id is unset the setting is NULL, the comparison is NULL, and no row is visible or
-- writable: the policies fail closed.

-- Roles are cluster-wide; every statement is guarded so re-running against another database is safe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'e2p_app') THEN
    -- NOLOGIN: deployments either GRANT e2p_app to their login role or ALTER ROLE ... LOGIN PASSWORD
    -- from a secret; tests and the pipeline use SET LOCAL ROLE e2p_app. Never SUPERUSER / BYPASSRLS.
    CREATE ROLE e2p_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;  -- lost a race with a parallel migration
END
$$;

-- New tables ---------------------------------------------------------------------------------------

-- Staff of a tenant. Roles mirror the Better Auth organization roles (owner/manager/staff).
-- phone_enc is AES-256-GCM ciphertext; phone_hash is HMAC-SHA256 for lookup (see src/security/pii.ts).
CREATE TABLE members (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants (id),
  role        text NOT NULL CHECK (role IN ('owner','manager','staff')),
  user_id     text,                       -- Better Auth user, when the member has a login
  phone_hash  text,
  phone_enc   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_hash)
);

CREATE TABLE resources (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants (id),
  location_id  text NOT NULL,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Customer phone numbers: ciphertext only, next to the HMAC lookup hash that already exists.
ALTER TABLE customers ADD COLUMN phone_enc text;

-- Row-level security ----------------------------------------------------------------------------------
-- ENABLE + FORCE on every tenant-scoped table; FORCE makes even the table owner obey the policies.
-- Superusers and BYPASSRLS roles still bypass: that is why the pipeline runs as e2p_app, and why the
-- ledger verify CLI (a read-only audit across tenants) connects as the owner role.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','customers','threads','rate_cards','ledger_entries','ledger_heads','members','resources']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END
$$;

-- Grants ------------------------------------------------------------------------------------------------
-- Least privilege for e2p_app. The ledger is INSERT/SELECT only (also enforced by triggers).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
-- Tables created later by the owner must not silently become reachable through the Data API.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;
-- The Data API (PostgREST) needs USAGE on the schema to see anything at all.
REVOKE ALL ON SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO e2p_app;

GRANT SELECT, INSERT ON tenants, rate_cards, ledger_entries TO e2p_app;
GRANT SELECT, INSERT, UPDATE ON customers, threads, ledger_heads TO e2p_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON members, resources TO e2p_app;
GRANT USAGE ON SEQUENCE ledger_entries_seq_seq TO e2p_app;
