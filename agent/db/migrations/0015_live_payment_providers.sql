-- 0015: allow the real provider names (test or live keys decide the mode) beside the simulators.
ALTER TABLE tenant_payment_config DROP CONSTRAINT IF EXISTS tenant_payment_config_provider_check;
ALTER TABLE tenant_payment_config ADD CONSTRAINT tenant_payment_config_provider_check
  CHECK (provider IN ('razorpay-sim','stripe-sim','razorpay','stripe'));
