// customerPayments.ts — record a customer payment with FIFO allocation
// against the customer's open credit sales (Section 6 of CLAUDE.md).
//
// Algorithm (oldest-first):
//   open_sales = SELECT s.id, total - SUM(allocations.amount), s.created_at
//                FROM sales s LEFT JOIN customer_payment_allocations a ...
//                WHERE customer_id = ? AND is_credit = 1 AND voided = 0
//                HAVING (total - allocated) > 0
//                ORDER BY created_at ASC
//   walk: allocate min(remaining_payment, sale_open_balance), advance, repeat.
//   excess: stays as unallocated payment (no allocation rows). Drives
//           customer balance negative — which is correctly read as
//           "shop owes them store credit."
//
// reconcileCustomerBalance recomputes customers.current_balance_pesewas
// from scratch:
//   balance = SUM(credit sale totals) − SUM(payments).
// Voided credit sales drop out (credit total goes down). Cleaner than
// trying to maintain an incremental running balance.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export type PaymentMethod = 'CASH' | 'MOMO' | 'BANK' | 'RETURN_CREDIT';

export interface RecordPaymentInput {
  customerId: string;
  shiftId: string | null;            // populated by handler from open shift
  amountPesewas: number;
  paymentMethod: PaymentMethod;
  paymentReference?: string;
  notes?: string;
}

export interface RecordPaymentResult {
  paymentId: string;
  allocations: Array<{ saleId: string; amountPesewas: number }>;
  unallocatedPesewas: number;        // becomes store credit
  newBalancePesewas: number;         // post-reconciliation
}

export function recordCustomerPayment(
  db: Database, input: RecordPaymentInput, workerId: string, deviceId: string,
): RecordPaymentResult {
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('Payment amount must be a positive whole number of pesewas.');
  }

  const cust = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(input.customerId);
  if (!cust) throw new Error('Customer not found.');

  const paymentId = `cp-${uuidv4()}`;
  let unallocated = input.amountPesewas;
  const allocations: RecordPaymentResult['allocations'] = [];

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO customer_payments
         (id, customer_id, shift_id, payment_method, amount_pesewas,
          payment_reference, notes, created_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      paymentId, input.customerId, input.shiftId,
      input.paymentMethod, input.amountPesewas,
      input.paymentReference?.trim() || null,
      input.notes?.trim() || null,
      workerId, deviceId,
    );

    // Open credit sales, oldest-first, with their unpaid balance.
    // Wrap in subquery so we can filter on the derived openBalance
    // without GROUP BY — SQLite (per spec) only allows HAVING with
    // aggregates. node-sqlite3-wasm enforces this strictly; the
    // wrapper pattern works on any SQLite.
    const openSales = db.prepare(
      `SELECT * FROM (
         SELECT s.id AS saleId,
                s.total_pesewas - COALESCE(
                  (SELECT SUM(amount_pesewas) FROM customer_payment_allocations
                    WHERE sale_id = s.id), 0
                ) AS openBalance,
                s.created_at AS createdAt
           FROM sales s
          WHERE s.customer_id = ? AND s.is_credit = 1 AND s.voided = 0
       )
       WHERE openBalance > 0
       ORDER BY createdAt ASC, saleId ASC`,
    ).all(input.customerId) as Array<{
      saleId: string; openBalance: number; createdAt: string;
    }>;

    const allocStmt = db.prepare(
      `INSERT INTO customer_payment_allocations
         (id, payment_id, sale_id, amount_pesewas, device_id)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (const s of openSales) {
      if (unallocated <= 0) break;
      const allocAmt = Math.min(unallocated, s.openBalance);
      allocStmt.run(`cpa-${uuidv4()}`, paymentId, s.saleId, allocAmt, deviceId);
      allocations.push({ saleId: s.saleId, amountPesewas: allocAmt });
      unallocated -= allocAmt;
    }

    logAudit(db, {
      workerId,
      action: 'CUSTOMER_PAYMENT_RECORDED',
      entityType: 'customer_payments',
      entityId: paymentId,
      afterValue: {
        customerId: input.customerId,
        amountPesewas: input.amountPesewas,
        paymentMethod: input.paymentMethod,
        allocationCount: allocations.length,
        unallocatedPesewas: unallocated,
      },
      deviceId,
    });
  });
  tx();

  const newBalance = reconcileCustomerBalance(db, input.customerId, workerId);
  return {
    paymentId,
    allocations,
    unallocatedPesewas: unallocated,
    newBalancePesewas: newBalance,
  };
}

/**
 * Recompute customers.current_balance_pesewas from the source of truth:
 *   credit_total = SUM(non-voided credit sale totals)
 *   paid_total   = SUM(all payments — allocated or not)
 *   balance      = credit_total − paid_total
 *
 * Negative balance means store credit: shop owes the customer.
 */
export function reconcileCustomerBalance(
  db: Database, customerId: string, workerId: string,
): number {
  const credit = (db.prepare(
    `SELECT COALESCE(SUM(total_pesewas), 0) AS v
       FROM sales
      WHERE customer_id = ? AND is_credit = 1 AND voided = 0`,
  ).get(customerId) as { v: number }).v;

  const paid = (db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS v
       FROM customer_payments
      WHERE customer_id = ?`,
  ).get(customerId) as { v: number }).v;

  const balance = credit - paid;
  db.prepare(
    `UPDATE customers
        SET current_balance_pesewas = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_by = ?
      WHERE id = ?`,
  ).run(balance, workerId, customerId);

  return balance;
}

// -- Read APIs for the renderer --------------------------------------------

export interface OpenCreditSale {
  saleId: string;
  createdAt: string;
  totalPesewas: number;
  paidPesewas: number;
  openBalancePesewas: number;
  paymentMethodOriginal: string;
  channel: string;
}

export function openCreditSalesForCustomer(
  db: Database, customerId: string,
): OpenCreditSale[] {
  return db.prepare(
    `SELECT * FROM (
       SELECT s.id AS saleId, s.created_at AS createdAt,
              s.total_pesewas AS totalPesewas,
              COALESCE(
                (SELECT SUM(amount_pesewas) FROM customer_payment_allocations
                  WHERE sale_id = s.id), 0
              ) AS paidPesewas,
              s.total_pesewas - COALESCE(
                (SELECT SUM(amount_pesewas) FROM customer_payment_allocations
                  WHERE sale_id = s.id), 0
              ) AS openBalancePesewas,
              s.payment_method AS paymentMethodOriginal,
              s.channel
         FROM sales s
        WHERE s.customer_id = ? AND s.is_credit = 1 AND s.voided = 0
     )
     WHERE openBalancePesewas > 0
     ORDER BY createdAt ASC`,
  ).all(customerId) as OpenCreditSale[];
}

export interface PaymentRow {
  paymentId: string;
  createdAt: string;
  amountPesewas: number;
  paymentMethod: PaymentMethod;
  paymentReference: string | null;
  notes: string | null;
  workerName: string;
  allocationCount: number;
  unallocatedPesewas: number;
}

export function listPaymentsForCustomer(
  db: Database, customerId: string, limit = 30,
): PaymentRow[] {
  return db.prepare(
    `SELECT p.id AS paymentId, p.created_at AS createdAt,
            p.amount_pesewas AS amountPesewas,
            p.payment_method AS paymentMethod,
            p.payment_reference AS paymentReference,
            p.notes,
            w.full_name AS workerName,
            (SELECT COUNT(*) FROM customer_payment_allocations
              WHERE payment_id = p.id) AS allocationCount,
            p.amount_pesewas - COALESCE(
              (SELECT SUM(amount_pesewas) FROM customer_payment_allocations
                WHERE payment_id = p.id), 0
            ) AS unallocatedPesewas
       FROM customer_payments p
       JOIN workers w ON w.id = p.created_by
      WHERE p.customer_id = ?
      ORDER BY p.created_at DESC
      LIMIT ?`,
  ).all(customerId, limit) as PaymentRow[];
}
