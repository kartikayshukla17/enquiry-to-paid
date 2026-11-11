-- 0020: refund and failed-payment events (V12, continuing T15). `payment.failed` and refund webhook
-- payloads were previously parsed into the generic "other" bucket and silently dropped by `handleWebhook`
-- (`if (ev.kind !== "paid") return { status: "ignored", ... }`). They now get their own typed ledger
-- entries -- `payment_failed` and `payment_refunded` -- distinct from both `collected` and
-- `payment_mismatch`.
--
-- Failed payment: a failed ATTEMPT does not consume the payment link -- Razorpay's own real behaviour is
-- that the customer can usually retry the SAME link afterward. This is closer to `payment_mismatch`'s
-- precedent (`payments.status` is left untouched; a correct event afterwards still collects) than to
-- V11's `payment_held_for_review` one (which is terminal because an expired quote genuinely has no
-- recovery path). `threads.state` is never touched either. No new `payments.status` value is needed for
-- this case.
--
-- Refund: happens AFTER a successful collection -- `payments.status` was already 'collected',
-- `threads.state` was already 'collected'. A refund is genuinely terminal (no "undo" of a refund), so
-- `payments.status` gets its own 'refunded' value, the same reasoning V11 added 'held_for_review' for: a
-- reconciliation view needs to be able to read this real, final outcome directly off `payments`.
-- `threads.state` is deliberately NOT touched -- ledger-only for v1, no owner-notification channel yet
-- (the same stub posture escalations had before V6 existed).
--
-- `provider_payment_id`: a refund's real payload (Razorpay's `refund.entity`, Stripe's Charge object)
-- carries the ORIGINAL payment id, not the payment link id, so the lookup in `handleWebhook` for a refund
-- needs to resolve by this id rather than by `provider_link_id` the way `paid`/`failed` do.
-- `providerPaymentId` was already known at collection time (it is on the `collected` ledger entry's
-- payload) but was never persisted as its own queryable column -- added here, and populated by
-- `handleWebhook`'s `collected` branch going forward (existing `collected` payments made before this
-- migration keep a null `provider_payment_id`, which is fine: nothing re-derives it retroactively, and no
-- refund test in this codebase needs one of those older rows).

ALTER TABLE payments ADD COLUMN provider_payment_id text;
CREATE INDEX payments_provider_payment_id_idx ON payments (tenant_id, provider, provider_payment_id);

ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('created', 'collected', 'mismatch', 'held_for_review', 'refunded'));

ALTER TABLE payment_events DROP CONSTRAINT payment_events_outcome_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_outcome_check
  CHECK (outcome IN ('collected', 'mismatch', 'unknown_link', 'ignored', 'held_for_review',
                      'failed', 'refunded', 'unknown_payment'));

ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check
  CHECK (type IN ('enquiry','extraction','quote','refusal','hold','owner_message',
                  'payment_link','collected','chase','correction','disclosure',
                  'rate_card_approved','rate_card_rejected','kill_switch_changed','payment_mismatch',
                  'owner_quote','consent','stop','chaser_sent','payment_held_for_review',
                  'payment_failed','payment_refunded'));
