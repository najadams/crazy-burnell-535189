-- 0001_lookup_tables.sql
-- Static lookup tables: reason_codes for stock_movements.

CREATE TABLE reason_codes (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('RECEIVE','OUTFLOW','ADJUSTMENT')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

INSERT INTO reason_codes (code, description, category) VALUES
  ('RECEIVED_FROM_SUPPLIER', 'Stock received from supplier', 'RECEIVE'),
  ('SALE',                   'Sale to customer',             'OUTFLOW'),
  ('SALE_VOID',              'Sale voided — stock returned', 'RECEIVE'),
  ('SALE_VOID_REVERSAL',     'Reversal of erroneous void',   'OUTFLOW'),
  ('BREAKAGE_INTERNAL',      'Stock broken in-store',        'OUTFLOW'),
  ('BREAKAGE_DELIVERY',      'Stock broken in delivery',     'OUTFLOW'),
  ('CONSUMPTION',            'Internal consumption',         'OUTFLOW'),
  ('RETURN_FROM_CUSTOMER',   'Stock returned by customer',   'RECEIVE'),
  ('STOCKTAKE_ADJUSTMENT',   'Stocktake correction',         'ADJUSTMENT');
