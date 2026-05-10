// supplierPayments.ts — record a payment we made to a supplier with
// FIFO allocation against the supplier's open invoices. Mirror of
// customerPayments.ts on the AP side.
//
// Algorithm (oldest-invoice-first):
//   open_invoices = SELECT i.id, total - SUM(allocations.amount), i.invoice_date
//                   FROM supplier_invoices i LEFT JOIN supplier_payment_allocations a ...
//                   WHERE supplier_id = ? AND is_payable = 1 AND voided = 0
//                   HAVING (total - allocated) > 0
//                   ORDER BY invoice_date ASC
//   walk: allocate min(remaining_payment, invoice_open_balance), advance, repeat.
//   excess: stays as unallocated payment (no allocation rows). Drives
//           supplier balance negative — read as "supplier owes us a
//           credit," which happens when we overpay or pre-pay.
//
// reconcileSupplierBalance recomputes suppliers.current_balance_pesewas:
//   balance = SUM(open invoice totals) − SUM(payments).
// Voided invoices and voided payments drop out.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export type SupplierPaymentMethod = 'CASH' | 'BANK' | 'MOMO' | 'CHEQUE';

export interface RecordSupplierPaymentInput {
  supplierId: string;
  amountPesewas: number;
  paymentMethod: SupplierPaymentMethod;
  paymentReference?: string;
  notes?: string;
  paidAt?: string;                    // ISO; defaults to now
}

export interface RecordSupplierPaymentResult {
  paymentId: string;
  allocations: Array<{ invoiceId: string; amountPesewas: number }>;
  unallocatedPesewas: number;
  newBalancePesewas: number;
}

export function recordSupplierPayment(
  db: Database, input: RecordSupplierPaymentInput,
  workerId: string, deviceId: string,
): RecordSupplierPaymentResult {
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('Payment amount must be a positive whole number of pesewas.');
  }

  const sup = db.prepare(`SELECT id FROM suppliers WHERE id = ?`)
    .get(input.supplierId);
  if (!sup) throw new Error('Supplier not found.');

  const paymentId = `sp-${uuidv4()}`;
  let unallocated = input.amountPesewas;
  const allocations: RecordSupplierPaymentResult['allocations'] = [];

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO supplier_payments
         (id, supplier_id, payment_method, amount_pesewas,
          payment_reference, paid_at, notes,
          created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, ?,
               COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               ?, ?, ?, ?)`,
    ).run(
      paymentId, input.supplierId, input.paymentMethod, input.amountPesewas,
      input.paymentReference?.trim() || null,
      input.paidAt ?? null,
      input.notes?.trim() || null,
      workerId, workerId, deviceId,
    );

    // Open invoices, oldest-first by invoice_date, with unpaid balance.
    // Subquery wrapper so we can filter on derived openBalance — same
    // pattern as customerPayments to keep node-sqlite3-wasm happy.
    const openInvoices = db.prepare(
      `SELECT * FROM (
         SELECT i.id AS invoiceId,
                i.total_pesewas - COALESCE(
                  (SELECT SUM(amount_pesewas) FROM supplier_payment_allocations
                    WHERE invoice_id = i.id), 0
                ) AS openBalance,
                i.invoice_date AS invoiceDate
           FROM supplier_invoices i
          WHERE i.supplier_id = ?
            AND i.is_payable = 1
            AND i.voided = 0
       )
       WHERE openBalance > 0
       ORDER BY invoiceDate ASC, invoiceId ASC`,
    ).all(input.supplierId) as Array<{
      invoiceId: string; openBalance: number; invoiceDate: string;
    }>;

    const allocStmt = db.prepare(
      `INSERT INTO supplier_payment_allocations
         (id, payment_id, invoice_id, amount_pesewas,
          created_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const i of openInvoices) {
      if (unallocated <= 0) break;
      const allocAmt = Math.min(unallocated, i.openBalance);
      allocStmt.run(
        `spa-${uuidv4()}`, paymentId, i.invoiceId, allocAmt,
        workerId, deviceId,
      );
      allocations.push({ invoiceId: i.invoiceId, amountPesewas: allocAmt });
      unallocated -= allocAmt;
    }

    logAudit(db, {
      workerId,
      action: 'SUPPLIER_PAYMENT_RECORDED',
      entityType: 'supplier_payments',
      entityId: paymentId,
      afterValue: {
        supplierId: input.supplierId,
        amountPesewas: input.amountPesewas,
        paymentMethod: input.paymentMethod,
        allocationCount: allocations.length,
        unallocatedPesewas: unallocated,
      },
      deviceId,
    });
  });
  tx();

  const newBalance = reconcileSupplierBalance(db, input.supplierId, workerId);
  return {
    paymentId,
    allocations,
    unallocatedPesewas: unallocated,
    newBalancePesewas: newBalance,
  };
}

/**
 * Recompute suppliers.current_balance_pesewas from the source of truth:
 *   invoiced = SUM(non-voided payable invoice totals)
 *   paid     = SUM(non-voided payments)
 *   balance  = invoiced − paid
 *
 * Positive balance: we owe the supplier.
 * Negative balance: supplier owes us (overpayment / prepayment).
 */
export function reconcileSupplierBalance(
  db: Database, supplierId: string, workerId: string,
): number {
  const invoiced = (db.prepare(
    `SELECT COALESCE(SUM(total_pesewas), 0) AS v
       FROM supplier_invoices
      WHERE supplier_id = ? AND is_payable = 1 AND voided = 0`,
  ).get(supplierId) as { v: number }).v;

  const paid = (db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS v
       FROM supplier_payments
      WHERE supplier_id = ? AND voided = 0`,
  ).get(supplierId) as { v: number }).v;

  const balance = invoiced - paid;
  db.prepare(
    `UPDATE suppliers
        SET current_balance_pesewas = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_by = ?
      WHERE id = ?`,
  ).run(balance, workerId, supplierId);

  return balance;
}

// -- Read APIs for the renderer --------------------------------------------

export interface OpenSupplierInvoice {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  paymentTermsDays: number;
  totalPesewas: number;
  paidPesewas: number;
  openBalancePesewas: number;
  dueDate: string;                  // invoice_date + terms (ISO)
}

export function openInvoicesForSupplier(
  db: Database, supplierId: string,
): OpenSupplierInvoice[] {
  return db.prepare(
    `SELECT * FROM (
       SELECT i.id AS invoiceId,
              i.invoice_number AS invoiceNumber,
              i.invoice_date AS invoiceDate,
              i.payment_terms_days AS paymentTermsDays,
              i.total_pesewas AS totalPesewas,
              COALESCE(
                (SELECT SUM(amount_pesewas) FROM supplier_payment_allocations
                  WHERE invoice_id = i.id), 0
              ) AS paidPesewas,
              i.total_pesewas - COALESCE(
                (SELECT SUM(amount_pesewas) FROM supplier_payment_allocations
                  WHERE invoice_id = i.id), 0
              ) AS openBalancePesewas,
              date(i.invoice_date, '+' || i.payment_terms_days || ' days') AS dueDate
         FROM supplier_invoices i
        WHERE i.supplier_id = ? AND i.is_payable = 1 AND i.voided = 0
     )
     WHERE openBalancePesewas > 0
     ORDER BY invoiceDate ASC`,
  ).all(supplierId) as OpenSupplierInvoice[];
}

export interface SupplierPaymentRow {
  paymentId: string;
  paidAt: string;
  amountPesewas: number;
  paymentMethod: SupplierPaymentMethod;
  paymentReference: string | null;
  notes: string | null;
  workerName: string;
  allocationCount: number;
  unallocatedPesewas: number;
}

export function listPaymentsForSupplier(
  db: Database, supplierId: string, limit = 30,
): SupplierPaymentRow[] {
  return db.prepare(
    `SELECT p.id AS paymentId, p.paid_at AS paidAt,
            p.amount_pesewas AS amountPesewas,
            p.payment_method AS paymentMethod,
            p.payment_reference AS paymentReference,
            p.notes,
            w.full_name AS workerName,
            (SELECT COUNT(*) FROM supplier_payment_allocations
              WHERE payment_id = p.id) AS allocationCount,
            p.amount_pesewas - COALESCE(
              (SELECT SUM(amount_pesewas) FROM supplier_payment_allocations
                WHERE payment_id = p.id), 0
            ) AS unallocatedPesewas
       FROM supplier_payments p
       JOIN workers w ON w.id = p.created_by
      WHERE p.supplier_id = ? AND p.voided = 0
      ORDER BY p.paid_at DESC
      LIMIT ?`,
  ).all(supplierId, limit) as SupplierPaymentRow[];
}
