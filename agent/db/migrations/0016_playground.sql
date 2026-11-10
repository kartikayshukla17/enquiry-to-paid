-- 0016: public playground (no tenant, no customer PII): visitor feedback and a per-visitor daily usage cap so a public
-- page cannot silently drain the Groq key. ip_hash is HMAC'd, never a raw IP; no RLS (not tenant data).

CREATE TABLE playground_feedback (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL,
  card       text NOT NULL,
  rating     text NOT NULL CHECK (rating IN ('up','down')),
  comment    text,
  CONSTRAINT playground_feedback_comment_len CHECK (comment IS NULL OR char_length(comment) <= 1000)
);

CREATE TABLE playground_usage (
  ip_hash text NOT NULL,
  day     date NOT NULL,
  count   int  NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
