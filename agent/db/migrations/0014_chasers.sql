-- 0014: chasers with consent (T19). SIMULATED WhatsApp: nothing here sends anything real.
-- No new table. Consent, stop requests and sent chasers are ledger entries (already under forced RLS); the "chase one at 24h,
-- chase two at 72h" schedule is a durable row in `timers` (kind 'chaser', subject = thread id).
--   consent      {action: requested | granted | revoked, customerId, source, ...}   customer-level facts; the newest one wins
--   stop         {customerId, matched, text, confirmed}                              the customer asked us to stop
--   chaser_sent  {n, quoteSeq, kind: free_text | template, template?, text, ...}      a chaser that really went out
--   chase        {action: cancelled, reason, quoteSeq}                                (existing kind) a pending chaser cancelled, with why
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check
  CHECK (type IN ('enquiry','extraction','quote','refusal','hold','owner_message',
                  'payment_link','collected','chase','correction','disclosure',
                  'rate_card_approved','rate_card_rejected','kill_switch_changed','payment_mismatch',
                  'owner_quote','consent','stop','chaser_sent'));
ALTER TABLE timers DROP CONSTRAINT timers_kind_check;
ALTER TABLE timers ADD CONSTRAINT timers_kind_check CHECK (kind IN ('hold_expiry','owner_idle_resume','chaser'));
-- "What is this customer's consent right now" is read on every quote and every stop word.
CREATE INDEX ledger_consent_idx ON ledger_entries (tenant_id, (payload->>'customerId'), tenant_seq) WHERE type = 'consent';
