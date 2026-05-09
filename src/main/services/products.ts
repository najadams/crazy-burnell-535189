// products.ts — read-only product list / search for the Sale screen.

import type { Database } from 'better-sqlite3';
import type { ProductSummary } from '../../shared/types/ipc.js';

const SELECT = `
  SELECT id, sku, name, category,
         walk_in_price_pesewas      AS walkInPricePesewas,
         wholesale_price_pesewas    AS wholesalePricePesewas,
         route_price_pesewas        AS routePricePesewas,
         cost_price_pesewas         AS costPricePesewas,
         active
    FROM products`;

export function listProducts(db: Database): ProductSummary[] {
  const rows = db.prepare(`${SELECT} WHERE active = 1 ORDER BY name ASC`).all();
  return rows.map((r: any) => ({ ...r, active: !!r.active })) as ProductSummary[];
}

export function searchProducts(db: Database, query: string, limit = 20): ProductSummary[] {
  const q = `%${query.toLowerCase().trim()}%`;
  if (!q || q === '%%') return listProducts(db).slice(0, limit);
  const rows = db.prepare(
    `${SELECT}
       WHERE active = 1
         AND (LOWER(name) LIKE ? OR LOWER(sku) LIKE ? OR barcode = ?)
       ORDER BY name ASC LIMIT ?`,
  ).all(q, q, query.trim(), limit);
  return rows.map((r: any) => ({ ...r, active: !!r.active })) as ProductSummary[];
}
