-- 0007: availability (T10). Postgres is the authority for blocked dates and held dates.
-- Every table carries tenant_id, forced RLS and the same tenant_isolation policy as 0004.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Owner/manager blocks (maintenance, private use). Inclusive date range.
CREATE TABLE availability_blocks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL REFERENCES tenants (id),
  resource_id  text NOT NULL REFERENCES resources (id),
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  reason       text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT 'owner_chat' CHECK (source IN ('owner_chat','calendar','system')),
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX availability_blocks_idx ON availability_blocks (tenant_id, resource_id, start_date, end_date);

-- A hold keeps a date for one thread until expires_at. `expires_at` is the quote-time clock, not now().
CREATE TABLE holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL REFERENCES tenants (id),
  resource_id  text NOT NULL REFERENCES resources (id),
  thread_id    text NOT NULL REFERENCES threads (id),
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  expires_at   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','released','confirmed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  -- Two active holds can never overlap on a resource, even under concurrent writers.
  CONSTRAINT holds_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, resource_id WITH =, daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status = 'active')
);
CREATE INDEX holds_thread_idx ON holds (tenant_id, thread_id);

-- Durable timers: a row in Postgres, claimed by `runDueTimers` with FOR UPDATE SKIP LOCKED.
CREATE TABLE timers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL REFERENCES tenants (id),
  kind        text NOT NULL CHECK (kind IN ('hold_expiry')),
  subject_id  text NOT NULL,
  run_at      timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  attempts    integer NOT NULL DEFAULT 0,
  done_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, subject_id)
);
CREATE INDEX timers_due_idx ON timers (run_at) WHERE status = 'pending';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['availability_blocks','holds','timers']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON availability_blocks TO e2p_app;
GRANT SELECT, INSERT, UPDATE ON holds, timers TO e2p_app;
