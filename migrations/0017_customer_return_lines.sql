-- 0017_customer_return_lines.sql
-- Wave C.3 — customer returns. Section 6.
--
-- customer_returns header already exists from migration 0005 (a
-- Wave H prerequisite with just id/customer_id/refund_method/
-- total_refund_pesewas/notes). This migration extends it with the
-- columns the full return flow needs:
--   - supervisor_approval_id: the consumed approval; required at
--     service level for every return (Section 6: "Supervisor PIN
--     required regardless of refund method")
--   - shift_id: the shift the refund attaches to (mandatory for
--     CASH refunds because the cash_counts row goes here)
--   - location_id: tagged for the day-lock gate so a sealed day
--     refuses new return rows
--
-- And adds the per-line table that captures what was returned at
-- what unit price (the refund price, not the original sale price —
-- gracious returns at a renegotiated rate are real).

ALTER TABLE customer_returns ADD COLUMN supervisor_approval_id TEXT
  REFERENCES supervisor_approvals(id);
ALTER TABLE customer_returns ADD COLUMN shift_id TEXT REFERENCES shifts(id);
ALTER TABLE customer_returns ADD COLUMN location_id TEXT REFERENCES locations(id);

CREATE TABLE customer_return_lines (
  id TEXT PRIMARY KEY,                            -- crl-{uuid}
  customer_return_id TEXT NOT NULL REFERENCES customer_returns(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  -- The refund price per unit. May or may not equal what the
  -- customer originally paid — depot might refund at cost for
  -- short-dated stock, or at full price for a wrong-product case.
  refund_unit_pesewas INTEGER NOT NULL CHECK (refund_unit_pesewas >= 0),
  line_total_pesewas INTEGER NOT NULL
    CHECK (line_total_pesewas = quantity * refund_unit_pesewas),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_customer_return_lines_return  ON customer_return_lines(customer_return_id);
CREATE INDEX idx_customer_return_lines_product ON customer_return_lines(product_id);
