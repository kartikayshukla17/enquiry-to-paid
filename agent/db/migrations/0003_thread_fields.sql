-- 0003: threads accumulate extracted fields across messages (later values override earlier ones).
-- tenant_id is already on threads (0001); the fields are tenant data and stay with the row.
ALTER TABLE threads ADD COLUMN fields jsonb NOT NULL DEFAULT '{}'::jsonb;
