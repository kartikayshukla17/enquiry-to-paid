-- 0009: kill switch (T28). A refuse-everything flag, global (platform) and per tenant.
--
-- The agent READS both flags at the start of every decision (as e2p_app, under RLS); it never writes them. A flip
-- is made by agent/src/killswitch (owner-role pool for global; tenant owner for tenant) and always appends a
-- 'kill_switch_changed' ledger entry in the same transaction.

-- One row, no tenant_id: it applies to all tenants. Exempt from RLS (listed in tenancy/exempt.ts); e2p_app is SELECT-only.
CREATE TABLE kill_switch_global (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),   -- singleton
  on_flag    boolean NOT NULL DEFAULT false,
  changed_at timestamptz,
  changed_by text
);
INSERT INTO kill_switch_global (id, on_flag) VALUES (true, false);
GRANT SELECT ON kill_switch_global TO e2p_app;

-- Per tenant: tenant_id + forced RLS like every other tenant table.
CREATE TABLE tenant_kill_switch (
  tenant_id  text PRIMARY KEY REFERENCES tenants (id),
  on_flag    boolean NOT NULL,
  changed_at timestamptz NOT NULL,
  changed_by text NOT NULL
);
ALTER TABLE tenant_kill_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_kill_switch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_kill_switch USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON tenant_kill_switch TO e2p_app;

ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check
  CHECK (type IN ('enquiry','extraction','quote','refusal','hold','owner_message',
                  'payment_link','collected','chase','correction','disclosure',
                  'rate_card_approved','rate_card_rejected','kill_switch_changed'));
