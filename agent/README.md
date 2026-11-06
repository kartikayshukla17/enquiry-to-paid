# agent

## Ledger tamper-evidence demo (T4)

Needs the local Postgres (`postgres://postgres:postgres@localhost:54329/e2p`) and `pnpm build:kernel` once.

```sh
export DB=postgres://postgres:postgres@localhost:54329/e2p
pnpm sim run fixtures/banquet-01.json        # migrates + writes 3 chained rows
pnpm ledger verify                           # OK (exit 0)

# 1. Edits are blocked by the database:
psql $DB -c "UPDATE ledger_entries SET payload='{}' WHERE tenant_seq=1"   # ERROR: ledger_entries is append-only
psql $DB -c "DELETE FROM ledger_entries"                                  # ERROR

# 2. Disable the trigger (superuser), edit anyway, and verify names the row:
psql $DB -c "ALTER TABLE ledger_entries DISABLE TRIGGER USER"
psql $DB -c "UPDATE ledger_entries SET payload='{}' WHERE tenant_seq=2"
psql $DB -c "ALTER TABLE ledger_entries ENABLE TRIGGER USER"
pnpm ledger verify          # BROKEN at tenant=... seq=... tenant_seq=2 reason=hash_mismatch (exit 1)
```

Reasons: `hash_mismatch` (row edited), `prev_hash_mismatch` (a row before it was edited and re-hashed),
`seq_gap` (a row was removed), `tail_truncated` (last rows removed; caught by `ledger_heads`).
Use `pnpm ledger verify --tenant <id>` for one tenant. Corrections are new `correction` rows whose
`corrects` points at the original `seq` (`appendCorrection`).
