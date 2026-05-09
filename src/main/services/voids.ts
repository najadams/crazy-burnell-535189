// voids.ts — void a previously rung-up sale.
//
// Effects (transactional):
//   1. Mark sales row voided + record voided_at, voided_by, void_reason.
//   2. For each sale_line, write a positive stock_movements row with
//      reason SALE_VOID — restoring goods to the shelf.
//   3. If the sale was on credit, subtract the total from the
//      customer's current_balance_pesewas (reverse the receivable).
//   4. Audit log row.
//
// Spec section 11: voids are SUPERVISOR-or-OWNER-gated. We use
// requireOwnerLike() at the IPC layer (single-cashier-plus-OWNER
// world) — when SUPERVISOR roles get added, switch to a dedicated
// requireSupervisorOrLikelier() helper.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export function voidSale(
  db: Database, saleId: string, workerId: string, reason: string,
  deviceId: string,
): { ok: true; reversedBalancePesewas: number } {
  const reasonClean = reason.trim();
  if (reasonClean.length < 3) {
    throw new Error('Please provide a void reason (at least a few characters).');
  }

  const sale = db.prepare(
    `SELECT id, voided, customer_id AS customerId, total_pesewas AS totalPesewas,
            is_credit AS isCredit, location_id AS locationId,
            shift_id AS shiftId
       FROM sales WHERE id = ?`,
  ).get(saleId) as
    | { id: string; voided: 0 | 1; customerId: string | null;
        totalPesewas: number; isCredit: 0 | 1; locationId: string;
        shiftId: string }
    | undefined;
  if (!sale) throw new Error('Sale not found.');
  if (sale.voided) throw new Error('Sale is already voided.');

  let reversedBalance = 0;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE sales
          SET voided = 1,
              voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              voided_by = ?,
              void_reason = ?
        WHERE id = ?`,
    ).run(workerId, reasonClean, saleId);

    // Restore stock for every line.
    const lines = db.prepare(
      `SELECT id, product_id AS productId, quantity,
              unit_cost_pesewas AS unitCostPesewas
         FROM sale_lines WHERE sale_id = ?`,
    ).all(saleId) as Array<{
      id: string; productId: string; quantity: number; unitCostPesewas: number;
    }>;

    const stockStmt = db.prepare(
      `INSERT INTO stock_movements
         (id, product_id, location_id, quantity, reason_code,
          shift_id, worker_id, customer_id,
          unit_cost_pesewas, total_value_pesewas,
          created_by, device_id)
       VALUES (?, ?, ?, ?, 'SALE_VOID', ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines) {
      stockStmt.run(
        `sm-${uuidv4()}`, l.productId, sale.locationId, l.quantity,
        sale.shiftId, workerId, sale.customerId,
        l.unitCostPesewas, l.unitCostPesewas * l.quantity,
        workerId, deviceId,
      );
    }

    // Reverse the customer's outstanding balance if it was a credit sale.
    if (sale.isCredit && sale.customerId) {
      db.prepare(
        `UPDATE customers
            SET current_balance_pesewas = current_balance_pesewas - ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                updated_by = ?
          WHERE id = ?`,
      ).run(sale.totalPesewas, workerId, sale.customerId);
      reversedBalance = sale.totalPesewas;
    }

    logAudit(db, {
      workerId,
      action: 'SALE_VOIDED',
      entityType: 'sales',
      entityId: saleId,
      beforeValue: {
        totalPesewas: sale.totalPesewas, isCredit: !!sale.isCredit,
      },
      afterValue: {
        reason: reasonClean,
        reversedBalancePesewas: reversedBalance,
        stockLinesRestored: lines.length,
      },
      deviceId,
    });
  });
  tx();

  return { ok: true, reversedBalancePesewas: reversedBalance };
}
