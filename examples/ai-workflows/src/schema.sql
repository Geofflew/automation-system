-- Everything lives in schema acme so the demo can drop and rebuild it on every run.
DROP SCHEMA IF EXISTS acme CASCADE;
CREATE SCHEMA acme;
SET search_path = acme, audit;

CREATE TABLE accounts (
  id     int PRIMARY KEY,
  name   text NOT NULL UNIQUE,
  owner  text NOT NULL,
  region text NOT NULL
);

CREATE TABLE deals (
  id         int PRIMARY KEY,
  account_id int NOT NULL REFERENCES accounts,
  stage      text NOT NULL CHECK (stage IN ('open', 'won', 'lost')),
  amount     int NOT NULL,
  closes_on  date NOT NULL
);

-- Open tickets feed the analyst. Resolved tickets are also the triage corpus: cause and
-- customer_check are what a customer can look at, staff_fix is what only staff can do.
CREATE TABLE tickets (
  id             int PRIMARY KEY,
  account_id     int NOT NULL REFERENCES accounts,
  subject        text NOT NULL,
  body           text NOT NULL,
  status         text NOT NULL CHECK (status IN ('open', 'resolved')),
  priority       text NOT NULL CHECK (priority IN ('low', 'normal', 'urgent')),
  opened_on      date NOT NULL,
  cause          text,
  customer_check text,
  staff_fix      text
);

-- The chat channel. reply_to is the thread parent.
CREATE TABLE messages (
  id       serial PRIMARY KEY,
  ts       text NOT NULL,
  author   text NOT NULL,
  text     text NOT NULL,
  reply_to int REFERENCES messages
);

-- One row per question a run took. The primary key is what stops two runs drafting the same one.
CREATE TABLE question_claims (
  message_id int PRIMARY KEY REFERENCES messages,
  run_id     text NOT NULL,
  status     text NOT NULL DEFAULT 'claimed',
  reason     text
);

CREATE TABLE proposals (
  turn_id     text PRIMARY KEY,
  session_id  text NOT NULL,
  seq         int NOT NULL,
  changes     jsonb NOT NULL,
  interactive boolean NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
);

CREATE TABLE webhook_events (
  event_id     text PRIMARY KEY,
  raw          text NOT NULL,
  processed_at text
);

-- What the support tool shows. 'customer' rows reach the customer; 'internal' rows do not.
-- event_id is the idempotency key a note is written under.
CREATE TABLE ticket_messages (
  id         serial PRIMARY KEY,
  ticket_id  int NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('internal', 'customer')),
  body       text NOT NULL,
  event_id   text UNIQUE
);

-- Shared by all four agents: who, what, when, a hash of the inputs, and what happened. In its own
-- schema so that rebuilding the data between demo sections keeps it.
CREATE SCHEMA IF NOT EXISTS audit;
CREATE TABLE IF NOT EXISTS audit.ledger (
  id          serial PRIMARY KEY,
  at          text NOT NULL,
  agent       text NOT NULL,
  actor       text NOT NULL,
  action      text NOT NULL,
  inputs_hash text NOT NULL,
  outcome     text NOT NULL
);
