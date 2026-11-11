-- 0017: thread_work_queue (V9, per-thread ordering for concurrent enquiries). Closes the residual gap left by
-- `timers`' own `FOR UPDATE SKIP LOCKED LIMIT 1` claim (which already stops two /tick calls grabbing the SAME
-- timer row): two DIFFERENT timer rows for the SAME thread (e.g. a due hold_expiry and a due chaser) could
-- otherwise be claimed by two truly concurrent /tick calls and processed at the same moment. This table makes
-- that claim durable and explicit, one row per thread, "claimed" or not.
--
-- No tenant_id, no RLS: it holds no tenant data (just a thread id — already a globally unique string in this
-- codebase — plus a bookkeeping timestamp/run-id) and is touched only by the agent's own trusted pool
-- connection (agent/src/timers/thread-queue.ts), never through e2p_app/RLS. Exempt from the tenant model the
-- same way kill_switch_global is (listed in tenancy/exempt.ts). Unlike kill_switch_global, e2p_app gets NO
-- grant at all here, not even SELECT: nothing tenant-scoped ever legitimately reads or writes this table, so
-- there is no read path to support (kill_switch_global's SELECT grant exists because the agent reads it from
-- under RLS on every decision; thread_work_queue has no such caller).
CREATE TABLE thread_work_queue (
  thread_id    text PRIMARY KEY REFERENCES threads(id),
  claimed_at   timestamptz,        -- NULL = unclaimed; SKIP LOCKED makes two tick runs never double-process one thread
  claimed_by   text                -- a run id, for diagnosing a stuck claim
);
