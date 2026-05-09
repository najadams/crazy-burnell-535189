-- 0004_shifts_sales_stock.sql
-- The transactional core: shifts, cash counts, sales, sale lines, stock
-- movements, append-only audit log.

CREATE TABLE shifts (
  id TEXT PRIMARY KEY,                            -- shift-{uuid}
  worker_id TEXT NOT NULL REFERENCES workers(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT,
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_shifts_worker_open ON shifts(worker_id, closed_at);

CREATE TABLE cash_counts (
  id TEXT PRIMARY KEY,                            -- cc-{uuid}
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  count_type TEXT NOT NULL CHECK (count_type IN
    ('OPENING','COUNTED_BLIND','CLOSING','CASH_DROP','ROUTE_COUNTED_BLIND')),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas >= 0),
  notes TEXT,
  parent_count_id TEXT REFERENCES cash_counts(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_cash_counts_shift ON cash_counts(shift_id, count_type);

CREATE TABLE sales (
  id TEXT PRIMARY KEY,                            -- sale-{uuid}
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  channel TEXT NOT NULL CHECK (channel IN ('WALK_IN','WHOLESALE','ROUTE')),
  customer_id TEXT REFERENCES customers(id),
  subtotal_pesewas INTEGER NOT NULL CHECK (subtotal_pesewas >= 0),
  total_pesewas INTEGER NOT NULL CHECK (total_pesewas >= 0),
  is_credit INTEGER NOT NULL DEFAULT 0 CHECK (is_credit IN (0,1)),
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0,1)),
  voided_at TEXT,
  voided_by TEXT REFERENCES workers(id),
  void_reason TEXT,
  payment_method TEXT NOT NULL DEFAULT 'CASH' CHECK (payment_method IN
    ('CASH','MOMO','BANK','CREDIT','MIXED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_sales_customer_voided_created ON sales(customer_id, voided, created_at);
CREATE INDEX idx_sales_shift ON sales(shift_id);
CREATE INDEX idx_sales_created_at ON sales(created_at);

CREATE TABLE sale_lines (
  id TEXT PRIMARY KEY,                            -- sl-{uuid}
  sale_id TEXT NOT NULL REFERENCES sales(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_pesewas INTEGER NOT NULL CHECK (unit_price_pesewas >= 0),
  unit_cost_pesewas INTEGER NOT NULL CHECK (unit_cost_pesewas >= 0),
  line_total_pesewas INTEGER NOT NULL,
  margin_pesewas INTEGER NOT NULL,
  -- kind + applied_promotion_id are spec'd in migration 0027 in the
  -- post-iteration-squash ledger; bundled into 0004 here so Wave H
  -- (migration 0033) can rely on them without a long migration tail.
  kind TEXT NOT NULL DEFAULT 'REGULAR' CHECK (kind IN ('REGULAR','BONUS')),
  applied_promotion_id TEXT,
  CHECK (line_total_pesewas = unit_price_pesewas * quantity),
  CHECK (margin_pesewas = (unit_price_pesewas - unit_cost_pesewas) * quantity)
);

CREATE INDEX idx_sale_lines_sale ON sale_lines(sale_id);
CREATE INDEX idx_sale_lines_product ON sale_lines(product_id);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,                            -- sm-{uuid}
  product_id TEXT NOT NULL REFERENCES products(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  quantity INTEGER NOT NULL CHECK (quantity != 0),
  reason_code TEXT NOT NULL REFERENCES reason_codes(code),
  shift_id TEXT REFERENCES shifts(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  customer_id TEXT REFERENCES customers(id),
  unit_cost_pesewas INTEGER NOT NULL DEFAULT 0,
  total_value_pesewas INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX idx_stock_movements_created ON stock_movements(created_at);

-- Append-only audit log. Service code writes one row per state-changing
-- action. Never delete; never update.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,                            -- al-{uuid}
  worker_id TEXT NOT NULL REFERENCES workers(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_value TEXT,        -- JSON (or NULL on insert)
  after_value TEXT,         -- JSON (or NULL on delete)
  device_id TEXT NOT NULL DEFAULT 'd-counter-1',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_worker ON audit_log(worker_id, created_at);
CREATE INDEX idx_audit_log_action ON audit_log(action, created_at);
