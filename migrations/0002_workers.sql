-- 0002_workers.sql
-- Workers + roles. PIN is bcrypt-hashed (bcryptjs in this scaffold;
-- spec calls for bcrypt-12 — bcryptjs supports the same cost factor).
--
-- created_by / updated_by point to workers(id) but we leave them
-- nullable because the very first OWNER row has no creator. Service
-- code populates them for every subsequent row.

CREATE TABLE workers (
  id TEXT PRIMARY KEY,                          -- w-{uuid}
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('CASHIER','SUPERVISOR','OWNER','FOUNDER')),
  pin_hash TEXT NOT NULL,
  recovery_code_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_workers_active_role ON workers(active, role);

-- Single-row table for shop-level config used on receipts and the home
-- screen header. Seeded by service code, not by SQL.
CREATE TABLE device_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  shop_name TEXT NOT NULL DEFAULT 'Counter Shop',
  shop_subtitle TEXT NOT NULL DEFAULT 'Beverage distributor',
  owner_phone TEXT,
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);
INSERT INTO device_config (id) VALUES (1);
