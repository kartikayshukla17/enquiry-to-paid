-- 0010: payment collection (T15). SIMULATED provider: nothing here talks to a real Razorpay.
--
-- `payments`: one row per payment link the agent issued for one of its own quotes (amount copied from the kernel
-- quote, integer minor units). `payment_events`: every provider webhook event id that passed signature verification,
-- so a replay is recognised and ignored. Both carry tenant_id and forced RLS like every tenant table.
-- The only writer of a `collected` ledger entry is agent/src/payments/webhook.ts (guarded by a test).

CREATE TABLE payments (
  id               text PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants (id),
  thread_id        text NOT NULL REFERENCES threads (id),
  quote_ledger_seq bigint NOT NULL,                       -- ledger_entries.seq of the agent-issued quote this link is for
  provider         text NOT NULL,
  provider_link_id text NOT NULL,
  link_url         text NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  currency         text NOT NULL,
  status           text NOT NULL DEFAULT 'created' CHECK (status IN ('created','collected','mismatch')),
  created_at       timestamptz NOT NULL,
  collected_at     timestamptz,
  UNIQUE (tenant_id, quote_ledger_seq),
  UNIQUE (tenant_id, provider, provider_link_id)
);
CREATE INDEX payments_thread_idx ON payments (tenant_id, thread_id);

CREATE TABLE payment_events (
  tenant_id   text NOT NULL REFERENCES tenants (id),
  provider    text NOT NULL,
  event_id    text NOT NULL,
  payment_id  text REFERENCES payments (id),
  outcome     text NOT NULL CHECK (outcome IN ('collected','mismatch','unknown_link','ignored')),
  detail      text,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, provider, event_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments', 'payment_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting('app.tenant_id', true))
         WITH CHECK (tenant_id = current_setting('app.tenant_id', true))$p$, t);
  END LOOP;
END
$$;
GRANT SELECT, INSERT, UPDATE ON payments TO e2p_app;
GRANT SELECT, INSERT ON payment_events TO e2p_app;

ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check
  CHECK (type IN ('enquiry','extraction','quote','refusal','hold','owner_message',
                  'payment_link','collected','chase','correction','disclosure',
                  'rate_card_approved','rate_card_rejected','kill_switch_changed','payment_mismatch'));
