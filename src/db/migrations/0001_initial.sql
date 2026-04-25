-- src/db/migrations/0001_initial.sql

CREATE TABLE users (
  user_id              TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  timezone             TEXT NOT NULL,
  age_years            INTEGER,
  dietary_pattern      TEXT,
  allergies_json       TEXT NOT NULL DEFAULT '[]',
  dislikes_json        TEXT NOT NULL DEFAULT '[]',
  daily_cost_cap_cents INTEGER NOT NULL DEFAULT 150,
  created_at           INTEGER NOT NULL
);

CREATE TABLE chat_threads (
  thread_id  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_chat_threads_user ON chat_threads(user_id);

CREATE TABLE chat_turns (
  turn_id          TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,
  actor            TEXT NOT NULL,
  status           TEXT NOT NULL,
  text             TEXT,
  user_text        TEXT,
  cost_usd         REAL,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  error            TEXT,
  idempotency_key  TEXT
);

CREATE INDEX idx_chat_turns_thread_ordinal ON chat_turns(thread_id, ordinal);
CREATE UNIQUE INDEX uq_chat_turns_idem
  ON chat_turns(thread_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE chat_tool_calls (
  turn_id          TEXT NOT NULL,
  call_index       INTEGER NOT NULL,
  tool_name        TEXT NOT NULL,
  input_json       TEXT NOT NULL,
  output_json      TEXT,
  idempotency_key  TEXT,
  duration_ms      INTEGER,
  error            TEXT,
  PRIMARY KEY (turn_id, call_index)
);

CREATE UNIQUE INDEX uq_chat_tool_calls_idem
  ON chat_tool_calls(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
