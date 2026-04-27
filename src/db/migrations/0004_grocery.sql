-- src/db/migrations/0004_grocery.sql

CREATE TABLE community_prices (
  upc              TEXT NOT NULL,
  store_place_id   TEXT NOT NULL,
  price            REAL NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'CAD',
  submitted_by     TEXT NOT NULL,
  submitted_at     INTEGER NOT NULL,
  PRIMARY KEY (upc, store_place_id, submitted_at)
);

CREATE INDEX idx_community_prices_lookup
  ON community_prices(upc, store_place_id, submitted_at DESC);

CREATE TABLE price_estimates (
  category         TEXT NOT NULL,
  region           TEXT NOT NULL,
  price            REAL NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'CAD',
  unit             TEXT NOT NULL,
  PRIMARY KEY (category, region)
);
