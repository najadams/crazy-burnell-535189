-- 0014_delivery_attempts.sql
-- Wave G chunk 4a. Two changes:
--   1. Add DRIVER to workers.role enum. SQLite can't ALTER a CHECK,
--      so we do the table-rebuild dance with deferred FK checks.
--   2. Create delivery_attempts table per Section 18.3.
--
-- defer_foreign_keys defers FK validation to the end of the
-- transaction, so the rebuild can drop+recreate workers without
-- breaking the many FKs that point at it. The integrity check fires
-- at COMMIT — if anything is wrong, the migration rolls back cleanly.
--
-- Pure schema; no data changes. Every existing worker row carries
-- through unchanged.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE workers_new (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN
    ('CASHIER','SUPERVISOR','OWNER','FOUNDER','DRIVER')),
  pin_hash TEXT NOT NULL,
  recovery_code_hash TEXT,
  recovery_code_issued_at TEXT,
  recovery_code_issued_by TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

INSERT INTO workers_new (
  id, full_name, role, pin_hash, recovery_code_hash,
  recovery_code_issued_at, recovery_code_issued_by,
  active, created_at, created_by, updated_at, updated_by, device_id
)
SELECT
  id, full_name, role, pin_hash, recovery_code_hash,
  recovery_code_issued_at, recovery_code_issued_by,
  active, created_at, created_by, updated_at, updated_by, device_id
FROM workers;

DROP TABLE workers;
ALTER TABLE workers_new RENAME TO workers;

CREATE INDEX idx_workers_active_role ON workers(active, role);

-- delivery_attempts: one row per pending_order capturing the
-- driver's outcome at the customer's location. UNIQUE(pending_order_id)
-- means re-recording for the same order overwrites — a single source
-- of truth per delivery rather than a history of attempts. (Multiple
-- physical visits to the same customer for the same order would all
-- collapse into one row; the spec's mention of separate attempts can
-- be added later if real partial-delivery cases need that granularity.)
CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,                            -- da-{uuid}
  route_run_id TEXT NOT NULL REFERENCES route_runs(id),
  pending_order_id TEXT NOT NULL REFERENCES pending_orders(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  outcome TEXT NOT NULL CHECK (outcome IN
    ('DELIVERED','PARTIAL','REFUSED','MISSED')),
  -- What the driver collected at this stop. Both default to 0 so
  -- MISSED/REFUSED outcomes don't need explicit zeroes.
  collected_cash_pesewas INTEGER NOT NULL DEFAULT 0
    CHECK (collected_cash_pesewas >= 0),
  collected_empties_count INTEGER NOT NULL DEFAULT 0
    CHECK (collected_empties_count >= 0),
  -- Driver-reported return intent — JSON list of {productId, qty,
  -- reason}. Processed formally at depot via customer_returns when
  -- Wave C.3 ships; for now this is just informational.
  return_intent_lines TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1',
  UNIQUE(pending_order_id)
);

CREATE INDEX idx_delivery_attempts_run     ON delivery_attempts(route_run_id);
CREATE INDEX idx_delivery_attempts_order   ON delivery_attempts(pending_order_id);
CREATE INDEX idx_delivery_attempts_outcome ON delivery_attempts(outcome, attempted_at);
