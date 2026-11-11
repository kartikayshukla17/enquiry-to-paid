-- 0018: groq_daily_usage (V10, global free-tier ceiling on real Groq network calls). One row per day, GLOBAL
-- (no tenant_id): every playground tenant shares one Groq API key, so the ceiling is account-wide, not
-- per-tenant. Incremented by every real extract/wordReply call against the live Groq adapter (never by
-- fixture/keyword providers or LLM_MODE=replay, which touch no network) so the account can never be driven
-- past Groq's own free-tier request-per-day limit into a raw 429 reaching a visitor.
--
-- No RLS: it holds no tenant data (a date, a counter) and is touched only by the agent's own trusted pool
-- connection (agent/src/llm/groq-ceiling.ts), never through e2p_app/RLS. Exempt from the tenant model the same
-- way kill_switch_global is (listed in tenancy/exempt.ts). No grant to e2p_app at all, the same as
-- thread_work_queue: nothing tenant-scoped ever legitimately reads or writes this table.
CREATE TABLE groq_daily_usage (
  day     date PRIMARY KEY,
  count   int NOT NULL DEFAULT 0
);
