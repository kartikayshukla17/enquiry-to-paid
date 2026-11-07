-- 0012: owner channel (T17). One new ledger entry kind: 'owner_quote' = a price the OWNER (or a manager) set for a
-- refused enquiry. It is deliberately a kind of its own, with payload.ownerPriced = true, so it can never be
-- mistaken for an agent-issued 'quote' (which carries a rate-card hash and is the only thing billing recognises).
-- No new table: refs are ledger tenant_seq values, "awaiting owner" is derived from the ledger and threads, so the
-- existing forced RLS on ledger_entries/threads/members covers everything the owner channel reads or writes.
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check
  CHECK (type IN ('enquiry','extraction','quote','refusal','hold','owner_message',
                  'payment_link','collected','chase','correction','disclosure',
                  'rate_card_approved','rate_card_rejected','kill_switch_changed','payment_mismatch',
                  'owner_quote'));
