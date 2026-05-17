// voids.ts — void a previously rung-up sale.
//
// Effects (transactional):
//   1. Mark sales row voided + record voided_at, voided_by, void_reason.
//   2. For each sale_line, write a positive stock_movements row with
//      reason SALE_VOID — restoring goods to the shelf.
//   3. If the sale was on credit, subtract the CREDIT-row amount from
//      the customer's current_balance_pesewas (reverse the receivable).
//   4. Audit log row.
//
// After migration 0007, the credit portion of a sale is no longer
// equal to its total — partial sales (cash + credit) have a CREDIT
// `sale_payments` row whose amount is just the credit portion. The
// void path reverses by SUM(sale_payments WHERE payment_method =
// 'CREDIT'), not by sales.total_pesewas. Falls back to total for
// any pre-backfill legacy sale that has no sale_payments rows
// (defensive — the backfill script should have been run, but the
// code shouldn't crash if it hasn't).
//
// Spec section 11: voids are SUPERVISOR-or-OWNER-gated. We use
// requireOwnerLike() at the IPC layer (single-cashier-plus-OWNER
// world) — when SUPERVISOR roles get added, switch to a dedicated
// requireSupervisorOrLikelier() helper.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';
import { assertNotSealed } from './periods.js';

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
            shift_id AS shiftId, created_at AS createdAt
       FROM sales WHERE id = ?`,
  ).get(saleId) as
    | { id: string; voided: 0 | 1; customerId: string | null;
        totalPesewas: number; isCredit: 0 | 1; locationId: string;
        shiftId: string; createdAt: string }
    | undefined;
  if (!sale) throw new Error('Sale not found.');
  if (sale.voided) throw new Error('Sale is already voided.');

  // Day-lock gate. Voiding a sale CHANGES that day's totals, so the
  // check is on the original sale's date, not today's. If the sale's
  // day is sealed, the OWNER must reopen it before the void.
  assertNotSealed(db, sale.locationId, sale.createdAt, 'Voiding this sale');

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

    // Reverse the customer's outstanding balance if it was a credit
    // sale. The amount reversed is the SUM of CREDIT-method
    // sale_payments rows for this sale — equal to total_pesewas for
    // a pure-credit sale, less for a partial. Pre-backfill legacy
    // sales have no rows; fall back to total in that case.
    if (sale.isCredit && sale.customerId) {
      const creditRow = db.prepare(
        `SELECT COALESCE(SUM(amount_pesewas), 0) AS creditSum,
                COUNT(*) AS rowCount
           FROM sale_payments
          WHERE sale_id = ? AND payment_method = 'CREDIT'`,
      ).get(saleId) as { creditSum: number; rowCount: number };
      // rowCount === 0 across the whole sale (any method) is the
      // pre-backfill legacy state — use total as the fall-back. If
      // there are non-credit rows but no credit rows, the sale was
      // fully paid at intake (shouldn't have is_credit=1, but if it
      // does, zero reversal is correct).
      const anyRows = db.prepare(
        `SELECT COUNT(*) AS n FROM sale_payments WHERE sale_id = ?`,
      ).get(saleId) as { n: number };
      const toReverse = anyRows.n === 0
        ? sale.totalPesewas
        : creditRow.creditSum;
      if (toReverse > 0) {
        db.prepare(
          `UPDATE customers
              SET current_balance_pesewas = current_balance_pesewas - ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                  updated_by = ?
            WHERE id = ?`,
        ).run(toReverse, workerId, sale.customerId);
      }
      reversedBalance = toReverse;
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
