// sales.ts — create a sale (with lines + stock movements + audit row).
//
// For the demo we trust the renderer's unitPrice / unitCost on each
// line — the renderer pulled them from products. The full pricing-
// precedence flow (Section 4) re-resolves at sale time and would
// belong here in a production build.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import type { SaleLineInput } from '../../shared/types/ipc.js';
import { logAudit } from './auditQuery.js';

export interface CreateSaleInput {
  shiftId: string;
  workerId: string;
  locationId: string;
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  customerId: string | null;
  lines: SaleLineInput[];
  paymentMethod: 'CASH' | 'MOMO' | 'BANK' | 'CREDIT';
  cashTenderedPesewas?: number;
}

export function createSale(
  db: Database, input: CreateSaleInput, deviceId: string,
): { saleId: string; totalPesewas: number; changePesewas: number } {
  if (input.lines.length === 0) {
    throw new Error('Add at least one line before completing the sale.');
  }
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error('Line quantity must be a positive whole number.');
    }
    if (!Number.isInteger(line.unitPricePesewas) || line.unitPricePesewas < 0) {
      throw new Error('Unit price must be a non-negative whole number of pesewas.');
    }
    if (!Number.isInteger(line.unitCostPesewas) || line.unitCostPesewas < 0) {
      throw new Error('Unit cost must be a non-negative whole number of pesewas.');
    }
  }

  const subtotal = input.lines.reduce(
    (s, l) => s + l.unitPricePesewas * l.quantity, 0,
  );
  const total = subtotal;            // no discounts/taxes in demo
  const isCredit = input.paymentMethod === 'CREDIT' ? 1 : 0;
  if (isCredit && !input.customerId) {
    throw new Error('Credit sales require a customer.');
  }

  let change = 0;
  if (input.paymentMethod === 'CASH') {
    const tendered = input.cashTenderedPesewas ?? total;
    if (tendered < total) {
      throw new Error('Cash tendered is less than total.');
    }
    change = tendered - total;
  }

  const saleId = `sale-${uuidv4()}`;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO sales
         (id, shift_id, worker_id, location_id, channel, customer_id,
          subtotal_pesewas, total_pesewas, is_credit, payment_method,
          created_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      saleId, input.shiftId, input.workerId, input.locationId,
      input.channel, input.customerId,
      subtotal, total, isCredit, input.paymentMethod,
      input.workerId, deviceId,
    );

    const lineStmt = db.prepare(
      `INSERT INTO sale_lines
         (id, sale_id, product_id, quantity,
          unit_price_pesewas, unit_cost_pesewas,
          line_total_pesewas, margin_pesewas, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REGULAR')`,
    );
    const stockStmt = db.prepare(
      `INSERT INTO stock_movements
         (id, product_id, location_id, quantity, reason_code,
          shift_id, worker_id, customer_id,
          unit_cost_pesewas, total_value_pesewas,
          created_by, device_id)
       VALUES (?, ?, ?, ?, 'SALE', ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const line of input.lines) {
      const lineTotal = line.unitPricePesewas * line.quantity;
      const margin = (line.unitPricePesewas - line.unitCostPesewas) * line.quantity;
      lineStmt.run(
        `sl-${uuidv4()}`, saleId, line.productId, line.quantity,
        line.unitPricePesewas, line.unitCostPesewas,
        lineTotal, margin,
      );
      // Stock outflow: negative quantity per the spec.
      stockStmt.run(
        `sm-${uuidv4()}`, line.productId, input.locationId,
        -line.quantity,
        input.shiftId, input.workerId, input.customerId ?? null,
        line.unitCostPesewas, line.unitCostPesewas * line.quantity,
        input.workerId, deviceId,
      );
    }

    // Credit sale: bump customer balance.
    if (isCredit && input.customerId) {
      db.prepare(
        `UPDATE customers
            SET current_balance_pesewas = current_balance_pesewas + ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                updated_by = ?
          WHERE id = ?`,
      ).run(total, input.workerId, input.customerId);
    }

    logAudit(db, {
      workerId: input.workerId,
      action: 'SALE_CREATED',
      entityType: 'sales',
      entityId: saleId,
      afterValue: {
        total, channel: input.channel, paymentMethod: input.paymentMethod,
        customerId: input.customerId, lineCount: input.lines.length,
      },
      deviceId,
    });
  });
  tx();

  return { saleId, totalPesewas: total, changePesewas: change };
}

export function recentSales(db: Database, limit = 20): Array<{
  id: string;
  createdAt: string;
  totalPesewas: number;
  customerId: string | null;
  customerName: string | null;
  workerName: string;
  voided: boolean;
}> {
  const rows = db.prepare(
    `SELECT s.id, s.created_at AS createdAt, s.total_pesewas AS totalPesewas,
            s.customer_id AS customerId,
            c.display_name AS customerName,
            w.full_name    AS workerName,
            s.voided
       FROM sales s
       JOIN workers w ON w.id = s.worker_id
       LEFT JOIN customers c ON c.id = s.customer_id
      ORDER BY s.created_at DESC LIMIT ?`,
  ).all(limit) as Array<any>;
  return rows.map((r) => ({ ...r, voided: !!r.voided }));
}
