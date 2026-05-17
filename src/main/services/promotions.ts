// promotions.ts — bonus-unit promotions ("buy N get M free").
// Wave D, Section 5 of CLAUDE.md.
//
// Two surfaces:
//   - CRUD: listPromotions, createPromotion, updatePromotion,
//     archivePromotion, reactivatePromotion. OWNER-only writes.
//   - computeBonusLines(): the algorithm sales.createSale calls
//     after computing regular lines. For each regular line, find
//     applicable promotions (same product, matching channel, within
//     validity window), pick the largest qty_buy that fits, and
//     emit a BONUS line if it does. Greedy-on-largest-threshold per
//     Section 5: 18 crates with a 12-buy and 6-buy promo fires the
//     12-buy once (3 free) rather than the 6-buy three times.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export type PromotionChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

export interface PromotionRow {
  id: string;
  productId: string;
  productName: string;
  channel: PromotionChannel | null;
  qtyBuy: number;
  qtyGetFree: number;
  validFrom: string;       // YYYY-MM-DD
  validTo: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
}

// --- CRUD --------------------------------------------------------------

export interface CreatePromotionInput {
  productId: string;
  channel: PromotionChannel | null;
  qtyBuy: number;
  qtyGetFree: number;
  validFrom: string;       // YYYY-MM-DD
  validTo: string | null;
  notes?: string;
  workerId: string;
}

function validateDates(validFrom: string, validTo: string | null): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
    throw new Error('valid_from must be YYYY-MM-DD.');
  }
  if (validTo !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validTo)) {
      throw new Error('valid_to must be YYYY-MM-DD or null.');
    }
    if (validTo < validFrom) {
      throw new Error('valid_to cannot be before valid_from.');
    }
  }
}

export function createPromotion(
  db: Database, input: CreatePromotionInput, deviceId: string,
): { promotionId: string } {
  if (!Number.isInteger(input.qtyBuy) || input.qtyBuy <= 0) {
    throw new Error('qty_buy must be a positive whole number.');
  }
  if (!Number.isInteger(input.qtyGetFree) || input.qtyGetFree <= 0) {
    throw new Error('qty_get_free must be a positive whole number.');
  }
  validateDates(input.validFrom, input.validTo);

  const prod = db.prepare(
    `SELECT id, name FROM products WHERE id = ? AND active = 1`,
  ).get(input.productId) as { id: string; name: string } | undefined;
  if (!prod) throw new Error('Product not found or inactive.');

  const id = `pr-${uuidv4()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO promotions
         (id, product_id, channel, qty_buy, qty_get_free,
          valid_from, valid_to, notes,
          created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.productId, input.channel,
      input.qtyBuy, input.qtyGetFree,
      input.validFrom, input.validTo,
      input.notes?.trim() || null,
      input.workerId, input.workerId, deviceId,
    );
    logAudit(db, {
      workerId: input.workerId,
      action: 'PROMOTION_CREATED',
      entityType: 'promotions',
      entityId: id,
      afterValue: {
        productId: input.productId, productName: prod.name,
        channel: input.channel,
        qtyBuy: input.qtyBuy, qtyGetFree: input.qtyGetFree,
        validFrom: input.validFrom, validTo: input.validTo,
      },
      deviceId,
    });
  });
  tx();
  return { promotionId: id };
}

export function listPromotions(
  db: Database, opts: { includeArchived?: boolean } = {},
): PromotionRow[] {
  const where = opts.includeArchived ? '' : 'WHERE p.active = 1';
  const rows = db.prepare(
    `SELECT p.id, p.product_id AS productId,
            pr.name AS productName,
            p.channel,
            p.qty_buy AS qtyBuy,
            p.qty_get_free AS qtyGetFree,
            p.valid_from AS validFrom,
            p.valid_to AS validTo,
            p.active,
            p.notes,
            p.created_at AS createdAt
       FROM promotions p
       JOIN products pr ON pr.id = p.product_id
       ${where}
       ORDER BY p.active DESC, p.valid_from DESC`,
  ).all() as Array<any>;
  return rows.map((r) => ({ ...r, active: !!r.active })) as PromotionRow[];
}

export function archivePromotion(
  db: Database,
  input: { promotionId: string; workerId: string },
  deviceId: string,
): void {
  const row = db.prepare(
    `SELECT id, active FROM promotions WHERE id = ?`,
  ).get(input.promotionId) as { id: string; active: 0 | 1 } | undefined;
  if (!row) throw new Error('Promotion not found.');
  if (!row.active) throw new Error('Promotion is already archived.');
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE promotions SET active = 0,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(input.workerId, input.promotionId);
    logAudit(db, {
      workerId: input.workerId,
      action: 'PROMOTION_ARCHIVED',
      entityType: 'promotions',
      entityId: input.promotionId,
      deviceId,
    });
  });
  tx();
}

export function reactivatePromotion(
  db: Database,
  input: { promotionId: string; workerId: string },
  deviceId: string,
): void {
  const row = db.prepare(
    `SELECT id, active FROM promotions WHERE id = ?`,
  ).get(input.promotionId) as { id: string; active: 0 | 1 } | undefined;
  if (!row) throw new Error('Promotion not found.');
  if (row.active) throw new Error('Promotion is already active.');
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE promotions SET active = 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(input.workerId, input.promotionId);
    logAudit(db, {
      workerId: input.workerId,
      action: 'PROMOTION_REACTIVATED',
      entityType: 'promotions',
      entityId: input.promotionId,
      deviceId,
    });
  });
  tx();
}

// --- computeBonusLines -------------------------------------------------

export interface RegularLineInput {
  productId: string;
  quantity: number;
}

export interface BonusLineOutput {
  productId: string;
  quantity: number;          // free units to emit
  promotionId: string;
  unitCostPesewas: number;   // cost per unit (so margin can be computed)
}

// Pick the best promotion for (productId, channel, atDate). "Best"
// = active + within validity + qty_buy <= regular_qty + LARGEST
// qty_buy that fits. Returns null if no eligible promo.
function findBestPromo(
  db: Database, productId: string, channel: PromotionChannel,
  atDate: string, regularQty: number,
): { promotionId: string; qtyBuy: number; qtyGetFree: number } | null {
  const row = db.prepare(
    `SELECT id, qty_buy AS qtyBuy, qty_get_free AS qtyGetFree
       FROM promotions
      WHERE product_id = ?
        AND active = 1
        AND valid_from <= ?
        AND (valid_to IS NULL OR valid_to >= ?)
        AND (channel IS NULL OR channel = ?)
        AND qty_buy <= ?
      ORDER BY qty_buy DESC
      LIMIT 1`,
  ).get(productId, atDate, atDate, channel, regularQty) as
    | { id: string; qtyBuy: number; qtyGetFree: number }
    | undefined;
  if (!row) return null;
  return { promotionId: row.id, qtyBuy: row.qtyBuy, qtyGetFree: row.qtyGetFree };
}

// For each regular line, emit a bonus line if a promotion applies.
// `atDate` is the YYYY-MM-DD the sale is dated to (typically today).
export function computeBonusLines(
  db: Database,
  channel: PromotionChannel,
  atDate: string,
  regularLines: RegularLineInput[],
): BonusLineOutput[] {
  const bonus: BonusLineOutput[] = [];
  for (const line of regularLines) {
    const promo = findBestPromo(db, line.productId, channel, atDate, line.quantity);
    if (!promo) continue;
    // Multiplier: how many times the threshold fits into the regular
    // quantity. 18 crates with a 12-buy promo fires once (multiplier
    // 1); 24 crates fires twice (multiplier 2). Section 5 specifies
    // greedy on the largest threshold, so once we've picked the
    // largest qty_buy, we apply it as many times as the regular
    // quantity allows.
    const multiplier = Math.floor(line.quantity / promo.qtyBuy);
    if (multiplier <= 0) continue;
    const freeUnits = multiplier * promo.qtyGetFree;
    const cost = db.prepare(
      `SELECT cost_price_pesewas AS c FROM products WHERE id = ?`,
    ).get(line.productId) as { c: number } | undefined;
    bonus.push({
      productId: line.productId,
      quantity: freeUnits,
      promotionId: promo.promotionId,
      unitCostPesewas: cost?.c ?? 0,
    });
  }
  return bonus;
}
