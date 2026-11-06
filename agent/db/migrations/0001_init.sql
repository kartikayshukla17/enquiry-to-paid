-- 0001: core tables. EVERY table carries tenant_id NOT NULL (tenants carries it as its own id).
-- RLS arrives in T5; hash chaining and append-only triggers arrive in T4.

CREATE TABLE tenants (
  id          text PRIMARY KEY,
  tenant_id   text GENERATED ALWAYS AS (id) STORED NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants (id),
  phone_hash  text NOT NULL,          -- sha256 of the normalised number; raw numbers are never stored in T1
  language    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_hash)
);

CREATE TABLE threads (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants (id),
  customer_id  text NOT NULL REFERENCES customers (id),
  state        text NOT NULL DEFAULT 'open'
               CHECK (state IN ('open','quoted','refused','paused_owner','booked','collected','closed')),
  paused_until timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_cards (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants (id),
  card_id      text NOT NULL,
  version      integer NOT NULL,
  content_hash text NOT NULL,         -- sha256 of canonical card JSON, computed by the kernel
  compiled     jsonb NOT NULL,        -- kernel input, opaque to TS
  approved_at  timestamptz,
  approved_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, card_id, version)
);

CREATE TABLE ledger_entries (
  seq            bigserial PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants (id),
  thread_id      text NOT NULL REFERENCES threads (id),
  at             timestamptz NOT NULL,
  type           text NOT NULL
                 CHECK (type IN ('enquiry','extraction','quote','refusal','hold','owner_message',
                                 'payment_link','collected','chase','correction')),
  payload        jsonb NOT NULL,
  rate_card_hash text,
  model_id       text,
  provider       text,
  region         text,
  cost_minor     bigint,
  prev_hash      text NOT NULL,
  hash           text NOT NULL,
  corrects       bigint REFERENCES ledger_entries (seq)
);

CREATE INDEX ledger_entries_thread_idx ON ledger_entries (tenant_id, thread_id, seq);
