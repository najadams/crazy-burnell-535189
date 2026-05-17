-- 0012_routes.sql
-- Wave G chunk 3: route definitions, route stops, and route runs.
-- Section 18.3 of CLAUDE.md.
--
-- `routes` is a stable rotation — name + weekday_pattern (e.g.
-- "TUE,FRI" for a route the driver runs every Tuesday and Friday).
-- `route_stops` is the ordered list of customers on that rotation;
-- UNIQUE(route_id, customer_id) means a customer can't be on the
-- same route twice. `route_runs` is one instance — one driver, one
-- date, with status moving through OPEN → RETURNING → CLOSED →
-- RECONCILED.
--
-- For chunk 3a the route_runs columns related to cash counts are
-- nullable; the open/close lifecycle and the cash-count FKs are
-- exercised in chunk 3b. The schema lands all at once so that
-- chunk doesn't need a follow-up migration.

CREATE TABLE routes (
  id TEXT PRIMARY KEY,                            -- rt-{uuid}
  name TEXT NOT NULL,
  -- Comma-separated weekday codes (MON/TUE/WED/THU/FRI/SAT/SUN).
  -- Empty string is allowed for ad-hoc / on-demand routes that
  -- don't follow a weekly cadence.
  weekday_pattern TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_routes_active ON routes(active);

CREATE TABLE route_stops (
  id TEXT PRIMARY KEY,                            -- rs-{uuid}
  route_id TEXT NOT NULL REFERENCES routes(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  -- Display + drive order within the route. Service code keeps
  -- this dense (no gaps) on reorder.
  stop_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1',
  UNIQUE(route_id, customer_id)
);

CREATE INDEX idx_route_stops_route_order ON route_stops(route_id, stop_order);
CREATE INDEX idx_route_stops_customer    ON route_stops(customer_id);

CREATE TABLE route_runs (
  id TEXT PRIMARY KEY,                            -- rrun-{uuid}
  route_id TEXT NOT NULL REFERENCES routes(id),
  -- YYYY-MM-DD; the day of operation. Combined with route_id gives
  -- uniqueness across active runs — one run per route per day.
  run_date TEXT NOT NULL CHECK (length(run_date) = 10),
  driver_id TEXT NOT NULL REFERENCES workers(id),
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT,
  reconciled_at TEXT,
  -- Cash counts. The opening count stays NULL under the
  -- zero-cash-float model (Section 8); the closing blind count
  -- gets set when the driver returns and counts what they're
  -- handing over. Both FKs are nullable; service code enforces
  -- ordering (can't reconcile without a closing count).
  opening_cash_count_id TEXT REFERENCES cash_counts(id),
  closing_blind_count_id TEXT REFERENCES cash_counts(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN
    ('OPEN','RETURNING','CLOSED','RECONCILED')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1',
  UNIQUE(route_id, run_date)
);

CREATE INDEX idx_route_runs_date_status   ON route_runs(run_date, status);
CREATE INDEX idx_route_runs_driver_status ON route_runs(driver_id, status);
