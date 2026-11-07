-- 0011: per-tenant payment provider selection (T16). SIMULATED providers only; the names are the PaymentProvider.name values.
-- One row per tenant; no row means the tenant has no payment provider and quotes carry no link. Forced RLS like every tenant table.
-- Switching a tenant's provider affects NEW links only: existing payments keep their own provider and still collect via it.

CREATE TABLE tenant_payment_config (
  tenant_id  text PRIMARY KEY REFERENCES tenants (id),
  provider   text NOT NULL CHECK (provider IN ('razorpay-sim','stripe-sim')),
  updated_at timestamptz NOT NULL
);
ALTER TABLE tenant_payment_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_payment_config FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_payment_config USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON tenant_payment_config TO e2p_app;
