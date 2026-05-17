-- 0010_period_closes.sql
-- Day-lock / period-close (Section 3 migration 0020 in the spec ledger,
-- 0010 in our shipped numbering). One row per (location, calendar date)
-- when an OWNER seals the day. Sealed days reject writes via service-
-- code `assertNotSealed` calls.
--
-- The reopen state is captured as an UPDATE on the same row, not a new
-- row — one reopen ever, the row is never deleted. A `reopened_at`
-- value means "this seal was lifted, writes may proceed again";
-- subsequent attempts to seal the same date hit the UNIQUE constraint
-- and require an OWNER to re-decide.
--
-- Audit log captures both PERIOD_SEALED and PERIOD_REOPENED — this row
-- alone doesn't preserve the seal/reopen sequence, just the latest
-- state. The audit log is the forensic record.

CREATE TABLE period_closes (
  id TEXT PRIMARY KEY,                            -- pc-{uuid}
  location_id TEXT NOT NULL REFERENCES locations(id),
  -- Calendar date in YYYY-MM-DD form, in the local-shop timezone.
  -- The service computes this from a passed-in ISO timestamp using
  -- slice(0,10) — i.e. the UTC date, which is fine for a
  -- single-shop deployment whose timezone is fixed. Multi-tz
  -- deployment would need a tz column too; out of scope.
  date TEXT NOT NULL CHECK (length(date) = 10),
  sealed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sealed_by TEXT NOT NULL REFERENCES workers(id),
  reopened_at TEXT,
  reopened_by TEXT REFERENCES workers(id),
  reopen_reason TEXT,
  device_id TEXT NOT NULL DEFAULT 'd-counter-1',
  UNIQUE(location_id, date)
);

CREATE INDEX idx_period_closes_location_date ON period_closes(location_id, date);
