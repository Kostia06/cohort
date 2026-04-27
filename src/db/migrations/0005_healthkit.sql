-- src/db/migrations/0005_healthkit.sql

CREATE TABLE health_samples_daily (
  user_id              TEXT NOT NULL,
  date                 TEXT NOT NULL,            -- YYYY-MM-DD local
  hrv_sdnn_ms          REAL,                     -- overnight HRV
  rhr_bpm              REAL,                     -- overnight RHR
  sleep_minutes        INTEGER,                  -- total time asleep last night
  time_in_bed_minutes  INTEGER,                  -- total time in bed
  active_kcal          INTEGER,                  -- active energy burned
  steps                INTEGER,
  source               TEXT NOT NULL DEFAULT 'healthkit',
  ingested_at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE INDEX idx_health_samples_user_date ON health_samples_daily(user_id, date DESC);
