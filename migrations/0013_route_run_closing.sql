-- 0013_route_run_closing.sql
-- Wave G chunk 3d. Close + reconcile metadata for route_runs.
--
-- Chunk 3a (migration 0012) shipped route_runs with the basic
-- columns. The blind cash count at return was supposed to use the
-- existing cash_counts table via closing_blind_count_id, but
-- cash_counts.shift_id is NOT NULL and a route_run doesn't naturally
-- belong to a shift (it spans whatever time the driver is out,
-- across possibly multiple shifts). Rather than alter cash_counts
-- to weaken shift_id (which affects shift-close math), we
-- denormalise: store the closing cash on route_runs directly. The
-- closing_blind_count_id FK stays NULLable for the future when we
-- formalise the blind-count flow.
--
-- Reconciliation is captured by reconciled_by + reconciliation_notes
-- alongside the existing reconciled_at column.

ALTER TABLE route_runs ADD COLUMN closing_cash_pesewas INTEGER
  CHECK (closing_cash_pesewas IS NULL OR closing_cash_pesewas >= 0);
ALTER TABLE route_runs ADD COLUMN closed_by TEXT REFERENCES workers(id);
ALTER TABLE route_runs ADD COLUMN reconciled_by TEXT REFERENCES workers(id);
ALTER TABLE route_runs ADD COLUMN reconciliation_notes TEXT;
ALTER TABLE route_runs ADD COLUMN reopened_at TEXT;
ALTER TABLE route_runs ADD COLUMN reopened_by TEXT REFERENCES workers(id);
ALTER TABLE route_runs ADD COLUMN reopen_reason TEXT;
