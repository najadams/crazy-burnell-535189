-- 0015_stocktake.sql
-- Stocktake / cycle counting. Without this, system stock drifts from
-- reality silently and the depot doesn't notice until they try to
-- commit an order they can't fulfil. The cycle: open a session,
-- walk-the-shelves recording counted quantities per product, close
-- the session which writes STOCKTAKE_ADJUSTMENT stock_movements for
-- every non-zero delta. Large deltas can be gated on a supervisor
-- approval at the service layer.
--
-- Pattern matches existing migrations: events table has a status
-- enum (OPEN → CLOSED or OPEN → CANCELLED), audit columns, and a
-- per-line table that survives the session.

CREATE TABLE stocktake_events (
  id TEXT PRIMARY KEY,                            -- ste-{uuid}
  location_id TEXT NOT NULL REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN
    ('OPEN','CLOSED','CANCELLED')),
  notes TEXT,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  opened_by TEXT NOT NULL REFERENCES workers(id),
  closed_at TEXT,
  closed_by TEXT REFERENCES workers(id),
  -- Optional supervisor approval consumed at close — required when
  -- the session contains any line with abs(delta) over the configured
  -- threshold. NULL when no over-threshold lines.
  supervisor_approval_id TEXT REFERENCES supervisor_approvals(id),
  cancel_reason TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_stocktake_events_location_status ON stocktake_events(location_id, status);
CREATE INDEX idx_stocktake_events_opened_at       ON stocktake_events(opened_at);

CREATE TABLE stocktake_lines (
  id TEXT PRIMARY KEY,                            -- stl-{uuid}
  stocktake_event_id TEXT NOT NULL REFERENCES stocktake_events(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  -- Expected quantity = SUM(stock_movements.quantity) for this
  -- product/location at the moment the line was recorded. Snapshot
  -- so the close-time math doesn't have to retro-compute from a
  -- moving target.
  expected_qty INTEGER NOT NULL,
  counted_qty INTEGER NOT NULL CHECK (counted_qty >= 0),
  -- Generated column: counted_qty - expected_qty. Positive = found
  -- more than expected (rare). Negative = shrinkage. Zero = clean.
  delta_qty INTEGER GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
  notes TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  recorded_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1',
  UNIQUE(stocktake_event_id, product_id)
);

CREATE INDEX idx_stocktake_lines_event   ON stocktake_lines(stocktake_event_id);
CREATE INDEX idx_stocktake_lines_product ON stocktake_lines(product_id);


-- Extend supervisor_approvals.purpose to include STOCKTAKE_LARGE_DELTA.
-- Same table-rebuild dance as migration 0014 used for workers.role.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE supervisor_approvals_new (
  id TEXT PRIMARY KEY,
  supervisor_worker_id TEXT NOT NULL REFERENCES workers(id),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'OVER_LIMIT_PARTIAL',
    'OVER_THRESHOLD_DISCOUNT',
    'BREAKAGE',
    'VOID_SALE',
    'CUSTOMER_RETURN',
    'STOCKTAKE_LARGE_DELTA'
  )),
  context_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_action TEXT,
  used_by_entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);
INSERT INTO supervisor_approvals_new SELECT * FROM supervisor_approvals;
DROP TABLE supervisor_approvals;
ALTER TABLE supervisor_approvals_new RENAME TO supervisor_approvals;

CREATE INDEX idx_supervisor_approvals_open
  ON supervisor_approvals(expires_at) WHERE used_at IS NULL;
CREATE INDEX idx_supervisor_approvals_supervisor_created
  ON supervisor_approvals(supervisor_worker_id, created_at);
CREATE INDEX idx_supervisor_approvals_used_entity
  ON supervisor_approvals(used_by_entity_id) WHERE used_at IS NOT NULL;
