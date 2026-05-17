-- 0011_pending_orders.sql
-- Wave G chunk 1: pending orders — the entity that route-distribution
-- intake produces, distinct from a completed sale. Spec Section 18.3.
--
-- The order lifecycle has eight states; the depot-only flow used
-- before the driver client ships (Stage 4D) typically goes:
--   CREATED → CONVERTED   (driver delivered + brought back cash;
--                          depot lead converts to a sale with the
--                          collected payment breakdown)
-- or
--   CREATED → CANCELLED   (customer changed mind, etc.)
--
-- The full lifecycle (with ASSIGNED, PICKED, OUT_FOR_DELIVERY,
-- DELIVERED, FAILED) lights up once routes (migration 0012) and
-- delivery_attempts (migration 0013) ship. The enum carries all
-- states from day one so we don't need a CHECK-constraint change
-- when those waves land.
--
-- The voice-intake agent (Section 19) was scoped out 2026-05-11;
-- intake_channel narrows to manual/phone/whatsapp-text only.
-- intake_confidence and intake_recording_path are NOT included
-- because no machine-derived intake exists.

CREATE TABLE pending_orders (
  id TEXT PRIMARY KEY,                            -- po-{uuid}
  customer_id TEXT NOT NULL REFERENCES customers(id),
  -- All orders are typed by a human at the depot under the current
  -- operating model. MANUAL = in-person walk-up or standing-order
  -- top-up; PHONE_CALL = depot lead transcribed a phone call;
  -- WHATSAPP_TEXT = depot lead transcribed a WhatsApp message.
  intake_channel TEXT NOT NULL CHECK (intake_channel IN
    ('MANUAL','PHONE_CALL','WHATSAPP_TEXT')),
  intake_worker_id TEXT NOT NULL REFERENCES workers(id),
  -- Optional snapshot of the desired delivery date — null when the
  -- customer didn't specify.
  requested_delivery_date TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN (
    'CREATED','ASSIGNED','PICKED','OUT_FOR_DELIVERY',
    'DELIVERED','FAILED','CONVERTED','CANCELLED'
  )),
  -- Manually flaggable by the depot lead when an order looks off
  -- (quantity spike, unfamiliar customer) and they want a second
  -- pair of eyes before it goes out. Defaults to 0; never auto-set.
  requires_review INTEGER NOT NULL DEFAULT 0 CHECK (requires_review IN (0,1)),
  -- Forward references that light up at later stages.
  assigned_route_run_id TEXT,    -- → route_runs(id) once migration 0012 lands
  pick_started_at TEXT,
  pick_completed_at TEXT,
  -- Set by convertToSale; null until the order becomes a sale.
  conversion_sale_id TEXT REFERENCES sales(id),
  converted_at TEXT,
  cancel_reason TEXT,
  cancelled_at TEXT,
  -- Audit columns.
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_pending_orders_status_created   ON pending_orders(status, created_at);
CREATE INDEX idx_pending_orders_customer_status  ON pending_orders(customer_id, status);
CREATE INDEX idx_pending_orders_conversion_sale  ON pending_orders(conversion_sale_id);

CREATE TABLE pending_order_lines (
  id TEXT PRIMARY KEY,                            -- pol-{uuid}
  pending_order_id TEXT NOT NULL REFERENCES pending_orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  -- Snapshot of the per-unit price at intake. The conversion step
  -- (convertToSale) may use this directly or re-resolve via the
  -- pricing precedence chain (Section 4) — current implementation
  -- uses the snapshot for simplicity; precedence re-resolution is a
  -- follow-up.
  unit_price_pesewas_at_intake INTEGER NOT NULL CHECK (unit_price_pesewas_at_intake >= 0),
  -- product_units don't ship yet (planned migration 0015). The FK
  -- column is reserved so when units do land, existing rows have a
  -- place to point. Nullable in the meantime.
  unit_id TEXT,
  notes TEXT,
  -- Audit columns (lines stay editable until the parent order is
  -- assigned; updates re-stamp).
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_pending_order_lines_order   ON pending_order_lines(pending_order_id);
CREATE INDEX idx_pending_order_lines_product ON pending_order_lines(product_id);
