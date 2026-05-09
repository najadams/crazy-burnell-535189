-- 0003_master_data.sql
-- Locations, suppliers, products, customers.

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_phone TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  pack_size_units INTEGER NOT NULL DEFAULT 1 CHECK (pack_size_units > 0),
  unit_volume_ml INTEGER,
  is_returnable INTEGER NOT NULL DEFAULT 0 CHECK (is_returnable IN (0,1)),
  bottle_deposit_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (bottle_deposit_pesewas >= 0),
  cost_price_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (cost_price_pesewas >= 0),
  walk_in_price_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (walk_in_price_pesewas >= 0),
  wholesale_price_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (wholesale_price_pesewas >= 0),
  route_price_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (route_price_pesewas >= 0),
  reorder_threshold INTEGER NOT NULL DEFAULT 0,
  reorder_quantity INTEGER NOT NULL DEFAULT 0,
  primary_supplier_id TEXT REFERENCES suppliers(id),
  canonical_unit TEXT NOT NULL DEFAULT 'BOTTLE',
  count_class TEXT CHECK (count_class IS NULL OR count_class IN ('A','B','C')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_products_active_name ON products(active, name);
CREATE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  phone TEXT NOT NULL CHECK (
    phone GLOB '+233[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
  ),
  customer_type TEXT NOT NULL CHECK (customer_type IN ('WALK_IN','WHOLESALE','ROUTE')),
  credit_limit_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit_pesewas >= 0),
  current_balance_pesewas INTEGER NOT NULL DEFAULT 0,
  preferred_channel TEXT CHECK (
    preferred_channel IS NULL OR preferred_channel IN ('WALK_IN','WHOLESALE','ROUTE')
  ),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),
  blocked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_customers_active_type ON customers(blocked, customer_type);
CREATE INDEX idx_customers_phone ON customers(phone);
