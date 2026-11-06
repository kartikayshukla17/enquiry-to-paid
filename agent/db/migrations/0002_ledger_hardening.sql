-- 0002: tamper-evident ledger. Append-only triggers, per-tenant hash chain.
-- Hashes are computed by the Rust kernel (chain_hash), never in SQL.

-- T1 rows carry a placeholder hash with no chain; they cannot verify, so they go before the
-- ledger becomes immutable (pre-release dev data only).
DELETE FROM ledger_entries;

-- Per-tenant sequence (1,2,3...). The global `seq` stays the primary key and the `corrects` target.
ALTER TABLE ledger_entries ADD COLUMN tenant_seq bigint NOT NULL;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_tenant_seq_unique UNIQUE (tenant_id, tenant_seq);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_correction_shape
  CHECK ((type = 'correction') = (corrects IS NOT NULL));

-- One head row per tenant: the lock that serialises appends and the anchor that makes
-- truncating the tail of a chain detectable.
CREATE TABLE ledger_heads (
  tenant_id       text PRIMARY KEY REFERENCES tenants (id),
  last_tenant_seq bigint NOT NULL,
  last_hash       text NOT NULL
);

CREATE FUNCTION ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed (write a correction entry instead)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_immutable();
