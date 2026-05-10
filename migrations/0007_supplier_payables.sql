-- 0007_supplier_payables.sql
-- Accounts payable: track what we owe each supplier and FIFO-allocate
-- payments to open invoices. Mirror of the customer-credit model
-- (sales + customer_payments + customer_payment_allocations) but on
-- the AP side. Driven by the route-distribution business buying anchor
-- brands on credit (Coke, Guinness, etc.) and paying in installments.
--
-- The existing flat stock_movements model still records the goods
-- inflow; this migration adds the *commercial* side: what was billed,
-- on what terms, and what's been paid. One supplier_invoice
-- corresponds to one delivery / one supplier-issued invoice.

ALTER TABLE suppliers ADD COLUMN current_balance_pesewas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN credit_limit_pesewas    INTEGER NOT NULL DEFAULT 0
  CHECK (credit_limit_pesewas >= 0);

CREATE TABLE supplier_invoices (
  id TEXT PRIMARY KEY,                              -- si-{uuid}
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  invoice_number TEXT,                              -- supplier's own ref, optional
  invoice_date TEXT NOT NULL,                       -- date supplier billed us
  payment_terms_days INTEGER NOT NULL DEFAULT 0
    CHECK (payment_terms_days >= 0),                -- 0 = COD, 7 = net-7, etc.
  total_pesewas INTEGER NOT NULL CHECK (total_pesewas > 0),
  -- is_payable=0 → fully paid at delivery (COD); skip allocation logic.
  -- is_payable=1 → open balance, allocate against it.
  is_payable INTEGER NOT NULL DEFAULT 1 CHECK (is_payable IN (0,1)),
  -- Soft pointer back to the audit_log row written by stockReceipts.
  -- Not an FK — audit_log is immutable and we don't want CASCADE pain.
  receipt_audit_id TEXT,
  notes TEXT,
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0,1)),
  voided_at TEXT,
  voided_by TEXT REFERENCES workers(id),
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_supplier_invoices_supplier_date
  ON supplier_invoices(supplier_id, invoice_date);

-- Partial index for the common "open invoices, oldest first" query path.
CREATE INDEX idx_supplier_invoices_supplier_open
  ON supplier_invoices(supplier_id, invoice_date)
  WHERE voided = 0 AND is_payable = 1;

CREATE TABLE supplier_payments (
  id TEXT PRIMARY KEY,                              -- sp-{uuid}
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  payment_method TEXT NOT NULL CHECK (payment_method IN
    ('CASH','BANK','MOMO','CHEQUE')),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  payment_reference TEXT,                           -- bank ref / cheque # / momo txn
  paid_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  notes TEXT,
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0,1)),
  voided_at TEXT,
  voided_by TEXT REFERENCES workers(id),
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_supplier_payments_supplier_paid
  ON supplier_payments(supplier_id, paid_at);

-- One row per (payment, invoice) pairing. Excess payment that doesn't
-- allocate to any open invoice lives implicitly: payment row exists,
-- sum of allocations < amount, and the supplier balance goes negative
-- (= we have credit with the supplier).
CREATE TABLE supplier_payment_allocations (
  id TEXT PRIMARY KEY,                              -- spa-{uuid}
  payment_id TEXT NOT NULL REFERENCES supplier_payments(id),
  invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_supplier_alloc_payment ON supplier_payment_allocations(payment_id);
CREATE INDEX idx_supplier_alloc_invoice ON supplier_payment_allocations(invoice_id);
