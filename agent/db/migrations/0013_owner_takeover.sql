-- 0013: owner takeover and handback (T18).
-- A thread the owner has taken over has state 'paused_owner' (allowed since 0001). The state it was in before the pause is
-- kept so a handback or idle resume puts it back exactly where it was. No new table: pause/handback/idle-resume are
-- 'owner_message' ledger entries (command pause | handback | idle_resume), already under forced RLS. The 12h idle resume is
-- a durable row in `timers` (kind owner_idle_resume, subject = thread id), so it needs the kind added to the check.
ALTER TABLE threads ADD COLUMN paused_from text;
ALTER TABLE timers DROP CONSTRAINT timers_kind_check;
ALTER TABLE timers ADD CONSTRAINT timers_kind_check CHECK (kind IN ('hold_expiry','owner_idle_resume'));
