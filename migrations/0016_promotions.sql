-- 0016_promotions.sql
-- Wave D — bonus-unit promotions ("buy N get M free"). Section 5 of
-- CLAUDE.md.
--
-- The sale_lines table already carries `kind` (REGULAR/BONUS) and
-- `applied_promotion_id` from migration 0004's bundled additions, so
-- this migration only needs the `promotions` table itself. Service
-- code wires `computeBonusLines` into the createSale path: after the
-- regular lines are computed, eligible promotions emit BONUS lines
-- with unit_price_pesewas = 0 and negative margin equal to the
-- bonus cost.
--
-- Matching rule: a promotion applies when a regular sale_line is
-- for the same product + channel and the sale's created_at falls
-- within the promotion's valid_from..valid_to window. Greedy on the
-- largest qty_buy that fits — a 12-buy promo is preferred over a
-- 6-buy promo so 12 crates fires the 12-buy once (3 free) rather
-- than the 6-buy twice (2 free). Section 5 calls this rule out
-- explicitly.

CREATE TABLE promotions (
  id TEXT PRIMARY KEY,                            -- pr-{uuid}
  -- The product this promo runs against. The customer must buy this
  -- product to trigger the bonus, and the bonus is the same product
  -- (free units of the same SKU). Multi-product promos ("buy crate
  -- of Coke, get a bottle of Sprite free") are a future extension.
  product_id TEXT NOT NULL REFERENCES products(id),
  -- Optional channel scope. NULL means the promotion applies to all
  -- channels; a specific value scopes it (e.g. only on ROUTE).
  channel TEXT CHECK (channel IS NULL OR channel IN ('WALK_IN','WHOLESALE','ROUTE')),
  qty_buy INTEGER NOT NULL CHECK (qty_buy > 0),
  qty_get_free INTEGER NOT NULL CHECK (qty_get_free > 0),
  -- Validity window. valid_from is required; valid_to NULL means
  -- "indefinitely until archived." Stored as YYYY-MM-DD strings.
  valid_from TEXT NOT NULL CHECK (length(valid_from) = 10),
  valid_to TEXT CHECK (valid_to IS NULL OR length(valid_to) = 10),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes TEXT,
  -- Audit columns.
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

CREATE INDEX idx_promotions_product_active
  ON promotions(product_id, active);
CREATE INDEX idx_promotions_validity
  ON promotions(valid_from, valid_to) WHERE active = 1;

-- Now that promotions exists, sale_lines.applied_promotion_id can
-- be sensibly populated by service code. Adding a FK constraint
-- retroactively in SQLite requires the table-rebuild dance for
-- sale_lines, which has many FKs of its own; skip for now and rely
-- on service code to populate correctly. The audit_log captures
-- every applied promotion via SALE_CREATED's bonus-line snapshot.
