-- 0005_wave_h_prereqs.sql
-- Customer returns table — Wave H's customerScorecard subtracts these
-- from window revenue (Section 20.10 of CLAUDE.md). The full Wave C.3
-- semantics (CASH/CREDIT/STORE refunds with synthetic cash drops or
-- payment allocations) are out of scope for this demo; just the header.

CREATE TABLE customer_returns (
  id TEXT PRIMARY KEY,                            -- cr-{uuid}
  customer_id TEXT NOT NULL REFERENCES customers(id),
  refund_method TEXT NOT NULL CHECK (refund_method IN ('CASH','CREDIT','STORE')),
  total_refund_pesewas INTEGER NOT NULL CHECK (total_refund_pesewas >= 0),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_customer_returns_customer_created
  ON customer_returns(customer_id, created_at);
