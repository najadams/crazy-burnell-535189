-- 0007_sale_payments.sql
-- Per-tender payment rows for sales. Spec Section 3 + Section 6.
--
-- Before this migration, every sale had a single payment_method column
-- on the `sales` row and pure-credit sales carried no payment record at
-- all (their balance impact was captured solely by the increment to
-- customers.current_balance_pesewas, with no row that a sum would tally
-- against). That made partial payments impossible to represent cleanly
-- — a customer who hands over ₵60 on a ₵100 sale couldn't be modelled
-- without lying to inventory or to the audit trail.
--
-- The new invariant, enforced in service code (see sales.ts):
--   For every non-voided sale, SUM(sale_payments.amount_pesewas) = sales.total_pesewas.
--   A fully-credit sale has one sale_payments row with method = 'CREDIT'.
--   A partial sale has one row per tender (e.g. CASH + CREDIT, MOMO + CREDIT,
--   or three rows for a CASH + MOMO + CREDIT split).
--
-- The legacy fully-credit sales that existed before this migration are
-- backfilled by scripts/backfill_credit_sale_payments.mjs to satisfy
-- the invariant retroactively.

CREATE TABLE sale_payments (
  id TEXT PRIMARY KEY,                            -- sp-{uuid}
  sale_id TEXT NOT NULL REFERENCES sales(id),
  payment_method TEXT NOT NULL CHECK (payment_method IN
    ('CASH','MOMO','BANK','CREDIT')),
  -- The portion of the sale this tender covers. Always > 0; a tender
  -- for zero pesewas is just noise. Sum across rows for a sale = total.
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  -- Optional reference: MoMo transaction id, bank slip number, cheque
  -- number, etc. NULL for CASH and CREDIT (no external reference).
  payment_reference TEXT,
  -- For CASH tenders only: what the customer actually handed over,
  -- which may exceed amount_pesewas. The difference is change due.
  -- NULL for non-cash methods. CHECK guarantees we never record cash
  -- given as less than the amount it covers (that would be the wrong
  -- shape of bug to discover at audit time).
  cash_given_pesewas INTEGER
    CHECK (cash_given_pesewas IS NULL OR cash_given_pesewas >= amount_pesewas),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

-- Sum-by-sale query is the dominant access pattern (validating the
-- invariant, computing balance changes on void).
CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);

-- Shift-cash math: at close, sum CASH rows by shift via JOIN sales.
-- Method-and-time filter is the second most common query (e.g. "show
-- me the MoMo receipts today"). Indexing both methods + created_at
-- keeps that range scan cheap.
CREATE INDEX idx_sale_payments_method_created
  ON sale_payments(payment_method, created_at);
