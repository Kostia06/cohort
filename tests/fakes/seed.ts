const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
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
CREATE TABLE IF NOT EXISTS chat_threads (
  thread_id  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads(user_id);
CREATE TABLE IF NOT EXISTS chat_turns (
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
CREATE INDEX IF NOT EXISTS idx_chat_turns_thread_ordinal ON chat_turns(thread_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_turns_idem ON chat_turns(thread_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS chat_tool_calls (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_tool_calls_idem ON chat_tool_calls(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS readiness_daily (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  score INTEGER,
  band TEXT,
  status TEXT NOT NULL,
  components_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS meals (
  meal_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  eaten_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  kcal INTEGER,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_meals_user_eaten ON meals(user_id, eaten_at DESC);
CREATE TABLE IF NOT EXISTS workouts (
  workout_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  duration_min INTEGER,
  rpe INTEGER,
  load_score REAL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'logged',
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date DESC);
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  body_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  generated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_user_date ON plans(user_id, date DESC);
CREATE TABLE IF NOT EXISTS research_papers (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT,
  authors_json TEXT,
  year INTEGER,
  journal TEXT,
  doi TEXT,
  domain TEXT,
  study_type TEXT,
  evidence_grade TEXT,
  population_json TEXT,
  key_findings_json TEXT,
  limitations_json TEXT,
  pdf_r2_key TEXT,
  uploaded_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_papers_status_added ON research_papers(status, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_papers_domain ON research_papers(domain);
CREATE TABLE IF NOT EXISTS research_summaries (
  paper_id TEXT NOT NULL,
  level TEXT NOT NULL,
  body TEXT NOT NULL,
  reading_minutes INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (paper_id, level)
);
CREATE TABLE IF NOT EXISTS research_chunks (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  ordinal INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_chunks_paper ON research_chunks(paper_id, ordinal);
`;

export async function applySchema(db: D1Database): Promise<void> {
  await db.exec(SCHEMA.replace(/\n/g, ' '));
}

export async function resetDb(db: D1Database): Promise<void> {
  await applySchema(db);
  await db.exec('DELETE FROM research_chunks; DELETE FROM research_summaries; DELETE FROM research_papers; DELETE FROM plans; DELETE FROM workouts; DELETE FROM meals; DELETE FROM readiness_daily; DELETE FROM chat_tool_calls; DELETE FROM chat_turns; DELETE FROM chat_threads; DELETE FROM users;');
}
