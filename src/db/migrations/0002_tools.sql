-- src/db/migrations/0002_tools.sql

CREATE TABLE readiness_daily (
  user_id        TEXT NOT NULL,
  date           TEXT NOT NULL,
  score          INTEGER,
  band           TEXT,
  status         TEXT NOT NULL,
  components_json TEXT NOT NULL,
  reasons_json   TEXT NOT NULL DEFAULT '[]',
  computed_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE meals (
  meal_id        TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  eaten_at       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  kcal           INTEGER,
  protein_g      REAL,
  carbs_g        REAL,
  fat_g          REAL,
  notes          TEXT,
  source         TEXT NOT NULL DEFAULT 'manual'
);

CREATE INDEX idx_meals_user_eaten ON meals(user_id, eaten_at DESC);

CREATE TABLE workouts (
  workout_id     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  date           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  duration_min   INTEGER,
  rpe            INTEGER,
  load_score     REAL,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'logged',
  source         TEXT NOT NULL DEFAULT 'manual'
);

CREATE INDEX idx_workouts_user_date ON workouts(user_id, date DESC);

CREATE TABLE plans (
  plan_id        TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  date           TEXT NOT NULL,
  body_json      TEXT NOT NULL,
  generated_at   INTEGER NOT NULL,
  generated_by   TEXT NOT NULL
);

CREATE INDEX idx_plans_user_date ON plans(user_id, date DESC);
