-- 0008: rate-card approval and activation gate (T14).
-- rate_cards already carries tenant_id, forced RLS and the tenant_isolation policy (0004); this only adds columns.
--
-- One row per compiled revision of a card. The pipeline quotes ONLY from the row with status 'approved'
-- (at most one per tenant+card, enforced by a partial unique index) and only while the stored snapshot still
-- hashes to `approved_hash`. A freshly compiled edit is a new 'draft' revision and never quotes.

ALTER TABLE rate_cards
  ADD COLUMN status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  ADD COLUMN approved_hash text,          -- content hash pinned at approval; equals content_hash
  ADD COLUMN source text,                 -- where the template came from (a path or a Sheet reference)
  ADD COLUMN readbacks jsonb,             -- the worked examples generated for the owner, fixed at generation
  ADD COLUMN rejection_reason text;       -- why the last approval attempt said no

ALTER TABLE rate_cards ADD CONSTRAINT rate_cards_approval_shape
  CHECK (status <> 'approved' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL AND approved_hash = content_hash));

CREATE UNIQUE INDEX rate_cards_one_active ON rate_cards (tenant_id, card_id) WHERE status = 'approved';

-- Approval is done by a member (owner or manager, checked in code against `members`).
ALTER TABLE rate_cards ADD CONSTRAINT rate_cards_approved_by_member FOREIGN KEY (approved_by) REFERENCES members (id);

-- The app role may record an approval decision, never rewrite the compiled snapshot or its hash.
GRANT UPDATE (status, approved_at, approved_by, approved_hash, readbacks, rejection_reason) ON rate_cards TO e2p_app;

-- The ledger records approvals at tenant level: they belong to no customer thread.
ALTER TABLE ledger_entries ALTER COLUMN thread_id DROP NOT NULL;
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check
  CHECK (type IN ('enquiry','extraction','quote','refusal','hold','owner_message',
                  'payment_link','collected','chase','correction','disclosure',
                  'rate_card_approved','rate_card_rejected'));
