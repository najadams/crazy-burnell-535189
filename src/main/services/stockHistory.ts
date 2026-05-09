// stockHistory.ts — read-only views over stock_movements.
//
// stockOnHand: SUM(quantity) per (product, location). Negative values
// mean we've sold more than we've received (which CAN happen if
// receipts haven't been entered yet — Tier-1 bug we're fixing). The UI
// flags negative on-hand in red so the OWNER notices.

import type { Database } from 'better-sqlite3';

export interface StockOnHandRow {
  productId: string;
  productName: string;
  sku: string;
  category: string | null;
  onHand: number;
  reorderThreshold: number;
  reorderQuantity: number;
  costPricePesewas: number;
}

export function stockOnHand(db: Database, locationId?: string): StockOnHandRow[] {
  const where = locationId ? 'WHERE sm.location_id = ?' : '';
  const params: unknown[] = locationId ? [locationId] : [];

  return db.prepare(
    `SELECT p.id   AS productId,
            p.name AS productName,
            p.sku,
            p.category,
            COALESCE(SUM(sm.quantity), 0) AS onHand,
            p.reorder_threshold AS reorderThreshold,
            p.reorder_quantity  AS reorderQuantity,
            p.cost_price_pesewas AS costPricePesewas
       FROM products p
  LEFT JOIN stock_movements sm ON sm.product_id = p.id
       ${where}
      WHERE p.active = 1
      GROUP BY p.id, p.name, p.sku, p.category, p.reorder_threshold,
               p.reorder_quantity, p.cost_price_pesewas
      ORDER BY p.name ASC`,
  ).all(...params) as StockOnHandRow[];
}
