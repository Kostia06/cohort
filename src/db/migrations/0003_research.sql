-- src/db/migrations/0003_research.sql

CREATE TABLE research_papers (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL,           -- 'pending' | 'extracting' | 'ready' | 'needs_ocr' | 'failed'
  title             TEXT,
  authors_json      TEXT,                    -- JSON array of author strings
  year              INTEGER,
  journal           TEXT,
  doi               TEXT,
  domain            TEXT,                    -- 'diet' | 'training' | 'sleep' | 'general'
  study_type        TEXT,                    -- 'RCT' | 'meta_analysis' | etc.
  evidence_grade    TEXT,                    -- 'A' | 'B' | 'C' | 'D'
  population_json   TEXT,
  key_findings_json TEXT,
  limitations_json  TEXT,
  pdf_r2_key        TEXT,                    -- r2 key under the research bucket
  uploaded_by       TEXT NOT NULL,           -- user_id (admin)
  added_at          INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_research_papers_status_added ON research_papers(status, added_at DESC);
CREATE INDEX idx_research_papers_domain ON research_papers(domain);

CREATE TABLE research_summaries (
  paper_id         TEXT NOT NULL,
  level            TEXT NOT NULL,            -- 'tldr' | 'plain' | 'detailed'
  body             TEXT NOT NULL,
  reading_minutes  INTEGER NOT NULL,
  generated_at     INTEGER NOT NULL,
  PRIMARY KEY (paper_id, level)
);

CREATE TABLE research_chunks (
  id        TEXT PRIMARY KEY,                -- '${paper_id}:${ordinal}'
  paper_id  TEXT NOT NULL,
  section   TEXT NOT NULL,
  text      TEXT NOT NULL,
  ordinal   INTEGER NOT NULL
);

CREATE INDEX idx_research_chunks_paper ON research_chunks(paper_id, ordinal);
