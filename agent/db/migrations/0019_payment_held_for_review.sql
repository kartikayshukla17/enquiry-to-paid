-- 0019: quote expiry re-checked inside the webhook itself (V11, continuing T15). `handleWebhook` now re-checks an
-- agent quote's own `validUntil` at the moment a `paid` event arrives (not only when the customer asks for the link
-- again, which `requestPaymentLink` already checked). A payment for an already-expired agent quote writes a new,
-- distinct ledger entry -- `payment_held_for_review` -- and does NOT collect.
--
-- Unlike `payment_mismatch` (wrong amount/currency: `payments.status` is deliberately left at 'created', because a
-- later CORRECT event for the same still-valid quote still collects), an expired quote can never become valid again:
-- there is no "the customer asks again and the SAME expired validUntil re-quotes"; a fresh enquiry after expiry gets
-- a brand new quote with a brand new `validUntil` (see README's "Expired quotes" ruling). So this money, once held,
-- stays held until a human resolves it -- it is never going to "still collect" on a retry the way a mismatch might.
-- That is reflected here as a real `payments.status` value (not just a ledger entry) so the V12 reconciliation view
-- can read "money received but held for review" directly off `payments`, without re-deriving it from the ledger.
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('created', 'collected', 'mismatch', 'held_for_review'));

ALTER TABLE payment_events DROP CONSTRAINT payment_events_outcome_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_outcome_check
  CHECK (outcome IN ('collected', 'mismatch', 'unknown_link', 'ignored', 'held_for_review'));

ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check
  CHECK (type IN ('enquiry','extraction','quote','refusal','hold','owner_message',
                  'payment_link','collected','chase','correction','disclosure',
                  'rate_card_approved','rate_card_rejected','kill_switch_changed','payment_mismatch',
                  'owner_quote','consent','stop','chaser_sent','payment_held_for_review'));
