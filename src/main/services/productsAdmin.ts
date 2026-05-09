// productsAdmin.ts — minimum: createProduct.
// Editing / deactivating is straightforward to add later; the demo
// requirement is "shop can grow its catalog without a developer."

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export interface CreateProductInput {
  sku: string;
  name: string;
  category: string | null;
  costPricePesewas: number;
  walkInPricePesewas: number;
  wholesalePricePesewas: number;
  routePricePesewas: number;
  reorderThreshold: number;
  reorderQuantity: number;
  unitVolumeMl: number | null;
  isReturnable: boolean;
  bottleDepositPesewas: number;
}

export function createProduct(
  db: Database, input: CreateProductInput, workerId: string, deviceId: string,
): { productId: string } {
  if (!input.sku.trim()) throw new Error('SKU is required.');
  if (!input.name.trim()) throw new Error('Name is required.');
  for (const [k, v] of Object.entries({
    cost: input.costPricePesewas, walkIn: input.walkInPricePesewas,
    wholesale: input.wholesalePricePesewas, route: input.routePricePesewas,
    deposit: input.bottleDepositPesewas,
  })) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`${k} price must be a non-negative whole number of pesewas.`);
    }
  }

  const productId = `prod-${uuidv4()}`;
  db.prepare(
    `INSERT INTO products
       (id, sku, name, category,
        pack_size_units, unit_volume_ml,
        is_returnable, bottle_deposit_pesewas,
        cost_price_pesewas, walk_in_price_pesewas,
        wholesale_price_pesewas, route_price_pesewas,
        reorder_threshold, reorder_quantity,
        canonical_unit, count_class,
        created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BOTTLE', NULL, ?, ?, ?)`,
  ).run(
    productId, input.sku.trim(), input.name.trim(), input.category?.trim() || null,
    input.unitVolumeMl, input.isReturnable ? 1 : 0, input.bottleDepositPesewas,
    input.costPricePesewas, input.walkInPricePesewas,
    input.wholesalePricePesewas, input.routePricePesewas,
    input.reorderThreshold, input.reorderQuantity,
    workerId, workerId, deviceId,
  );

  logAudit(db, {
    workerId,
    action: 'PRODUCT_CREATED',
    entityType: 'products',
    entityId: productId,
    afterValue: input,
    deviceId,
  });

  return { productId };
}
