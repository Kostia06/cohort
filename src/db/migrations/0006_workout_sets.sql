CREATE TABLE workout_sets (
  set_id        TEXT PRIMARY KEY,
  workout_id    TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  exercise      TEXT NOT NULL,
  reps          INTEGER,
  weight_kg     REAL,
  rpe           INTEGER,
  notes         TEXT,
  logged_at     INTEGER NOT NULL
);

CREATE INDEX idx_workout_sets_workout ON workout_sets(workout_id, ordinal);
