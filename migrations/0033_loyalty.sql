-- 0033_loyalty.sql
-- Wave H — customer performance & loyalty tiers (planned, Stage 4B parallel
-- to Wave G core).
--
-- Adds:
--   1. Manual loyalty tier columns on customers (owner-set flag with audit).
--   2. loyalty_thresholds table — owner-configurable rules driving the
--      computed tier. The computed tier is calculated at read time, not
--      cached (per Section 20.3 of CLAUDE.md).
--
-- The migration is purely structural. Default thresholds are seeded at
-- first-run by a runtime helper (`ensureLoyaltyDefaults(db, ownerWorkerId)`)
-- so we don't need a synthetic system worker_id to satisfy the FK on
-- created_by; that helper runs after the first OWNER row exists.

-- 1. Manual tier on customers ------------------------------------------------
ALTER TABLE customers ADD COLUMN loyalty_tier_manual TEXT NULL
  CHECK (loyalty_tier_manual IS NULL OR loyalty_tier_manual IN
    ('VIP', 'GOLD', 'SILVER', 'STANDARD'));

ALTER TABLE customers ADD COLUMN loyalty_tier_manual_set_at TEXT NULL;

ALTER TABLE customers ADD COLUMN loyalty_tier_manual_set_by TEXT NULL
  REFERENCES workers(id);

ALTER TABLE customers ADD COLUMN loyalty_tier_manual_reason TEXT NULL;

-- 2. Owner-configurable thresholds for the COMPUTED tier --------------------
-- Evaluation order at read time: VIP → GOLD → SILVER → STANDARD; first
-- match wins. Per (tier, metric, window_days) only one row may be active
-- — the unique partial index enforces this without blocking historic
-- (deactivated) rows from sticking around for audit.
CREATE TABLE loyalty_thresholds (
  id TEXT PRIMARY KEY,                              -- lt-{uuid}
  tier TEXT NOT NULL CHECK (tier IN ('VIP','GOLD','SILVER','STANDARD')),
  metric TEXT NOT NULL CHECK (metric IN
    ('REVENUE_PESEWAS','MARGIN_PESEWAS','ORDER_COUNT')),
  window_days INTEGER NOT NULL CHECK (window_days > 0),
  min_value INTEGER NOT NULL CHECK (min_value >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_loyalty_thresholds_unique_active
  ON loyalty_thresholds(tier, metric, window_days)
  WHERE active = 1;

CREATE INDEX idx_loyalty_thresholds_tier_active
  ON loyalty_thresholds(tier) WHERE active = 1;
