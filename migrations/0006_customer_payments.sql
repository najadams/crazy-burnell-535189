-- 0006_customer_payments.sql
-- Customer payments + FIFO allocations against open credit sales.
-- Spec Section 6.

CREATE TABLE customer_payments (
  id TEXT PRIMARY KEY,                            -- cp-{uuid}
  customer_id TEXT NOT NULL REFERENCES customers(id),
  -- shift_id is populated for CASH payments so closing-shift math can
  -- attribute them to the right shift's till. Non-cash payments may
  -- come in after-hours (MoMo / bank transfer notifications) and
  -- legitimately have no shift.
  shift_id TEXT REFERENCES shifts(id),
  payment_method TEXT NOT NULL CHECK (payment_method IN
    ('CASH','MOMO','BANK','RETURN_CREDIT')),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  payment_reference TEXT,                         -- MoMo / bank txn id
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_customer_payments_customer_created
  ON customer_payments(customer_id, created_at);
CREATE INDEX idx_customer_payments_shift_method
  ON customer_payments(shift_id, payment_method);

-- One allocation row per (payment, sale) pairing. Excess payment that
-- doesn't allocate to any open sale lives implicitly: the payment row
-- exists but no allocations exist, so the sum of allocations < the
-- payment amount. The customer balance going negative (= store credit)
-- is the natural representation.
CREATE TABLE customer_payment_allocations (
  id TEXT PRIMARY KEY,                            -- cpa-{uuid}
  payment_id TEXT NOT NULL REFERENCES customer_payments(id),
  sale_id TEXT NOT NULL REFERENCES sales(id),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_payment_allocations_payment ON customer_payment_allocations(payment_id);
CREATE INDEX idx_payment_allocations_sale    ON customer_payment_allocations(sale_id);
