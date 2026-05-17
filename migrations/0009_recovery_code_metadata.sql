-- 0009_recovery_code_metadata.sql
-- Tracking columns for the OWNER PIN recovery flow (Section 10).
-- The recovery_code_hash column already exists on workers (migration
-- 0002 declared it). This migration adds:
--   - recovery_code_issued_at: ISO timestamp of last issuance, so the
--     UI can show "regenerated 3 days ago" and detect stale codes.
--   - recovery_code_issued_by: FK to workers(id) — who triggered the
--     regenerate. Self-referential on rotation via Forgot PIN
--     (workerId = target = issuer).
--
-- The plaintext recovery code is never stored; only the bcrypt-12
-- hash sits on the row. Service code (recovery.ts) is the gate.

ALTER TABLE workers ADD COLUMN recovery_code_issued_at TEXT;
ALTER TABLE workers ADD COLUMN recovery_code_issued_by TEXT REFERENCES workers(id);
