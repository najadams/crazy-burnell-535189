// customerReturns.ts — record a customer return. Wave C.3, Section 6.
//
// Distinct from a void: the customer brings goods back days after
// the original sale was completed. We:
//   1. Validate supervisor approval (consumed in tx).
//   2. Validate day-lock for the location.
//   3. Insert customer_returns header + customer_return_lines.
//   4. For each line: positive RETURN_FROM_CUSTOMER stock_movements
//      (goods returned to shelf).
//   5. Refund:
//      - CASH: write cash_counts CASH_DROP row tagged with the
//        return id. Till math handles it like any drop.
//      - CREDIT: write customer_payments row (payment_method=
//        'RETURN_CREDIT') with FIFO allocation against open
//        credit sales; reconcile customer balance.
//      - STORE: rejected — Section 17 open question. CREDIT does
//        double duty until a real store-credit ledger exists.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';
import { consumeSupervisorApproval } from './supervisorApprovals.js';
import { assertNotSealed } from './periods.js';
import { recordCustomerPayment } from './customerPayments.js';

export type RefundMethod = 'CASH' | 'CREDIT';   // STORE intentionally omitted

export interface ReturnLineInput {
  productId: string;
  quantity: number;
  refundUnitPesewas: number;
  notes?: string;
}

export interface RecordCustomerReturnInput {
  customerId: string;
  workerId: string;            // who's recording it
  refundMethod: RefundMethod;
  shiftId: string;             // attaches CASH refund to till
  locationId: string;          // day-lock gate
  supervisorApprovalId: string; // mandatory per Section 6
  lines: ReturnLineInput[];
  notes?: string;
}

export interface RecordCustomerReturnResult {
  customerReturnId: string;
  totalRefundPesewas: number;
  newBalancePesewas?: number;  // only set for CREDIT path
}

export function recordCustomerReturn(
  db: Database, input: RecordCustomerReturnInput, deviceId: string,
): RecordCustomerReturnResult {
  if (input.lines.length === 0) {
    throw new Error('A return must have at least one line.');
  }
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw new Error('Return line quantity must be a positive whole number.');
    }
    if (!Number.isInteger(l.refundUnitPesewas) || l.refundUnitPesewas < 0) {
      throw new Error('Refund unit price must be a non-negative whole number of pesewas.');
    }
  }

  // STORE rejected at service level even though the schema allows
  // the value (Section 17). When a real store-credit ledger ships,
  // delete this check.
  if ((input.refundMethod as string) === 'STORE') {
    throw new Error('STORE refund method is not yet supported. Use CREDIT — it does double duty until a real store-credit ledger ships.');
  }

  const cust = db.prepare(
    `SELECT id, display_name AS displayName, blocked, current_balance_pesewas AS balance
       FROM customers WHERE id = ?`,
  ).get(input.customerId) as
    | { id: string; displayName: string; blocked: 0 | 1; balance: number }
    | undefined;
  if (!cust) throw new Error('Customer not found.');

  // Day-lock gate
  assertNotSealed(db, input.locationId, new Date().toISOString(), 'Recording this customer return');

  // Total refund
  const totalRefund = input.lines.reduce(
    (s, l) => s + l.quantity * l.refundUnitPesewas, 0,
  );
  if (totalRefund <= 0) {
    throw new Error('Total refund must be greater than zero.');
  }

  const customerReturnId = `cr-${uuidv4()}`;
  let newBalancePesewas: number | undefined;

  const tx = db.transaction(() => {
    // Consume supervisor approval (purpose CUSTOMER_RETURN).
    consumeSupervisorApproval(db, {
      approvalId: input.supervisorApprovalId,
      expectedPurpose: 'CUSTOMER_RETURN',
      action: 'CUSTOMER_RETURN_RECORDED',
      entityId: customerReturnId,
    });

    db.prepare(
      `INSERT INTO customer_returns
         (id, customer_id, refund_method, total_refund_pesewas, notes,
          supervisor_approval_id, shift_id, location_id,
          created_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      customerReturnId, input.customerId, input.refundMethod, totalRefund,
      input.notes?.trim() || null,
      input.supervisorApprovalId, input.shiftId, input.locationId,
      input.workerId, deviceId,
    );

    const lineStmt = db.prepare(
      `INSERT INTO customer_return_lines
         (id, customer_return_id, product_id, quantity,
          refund_unit_pesewas, line_total_pesewas, notes,
          created_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const stockStmt = db.prepare(
      `INSERT INTO stock_movements
         (id, product_id, location_id, quantity, reason_code,
          shift_id, worker_id, customer_id,
          unit_cost_pesewas, total_value_pesewas,
          created_by, device_id)
       VALUES (?, ?, ?, ?, 'RETURN_FROM_CUSTOMER', ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const l of input.lines) {
      const lineTotal = l.quantity * l.refundUnitPesewas;
      lineStmt.run(
        `crl-${uuidv4()}`, customerReturnId, l.productId, l.quantity,
        l.refundUnitPesewas, lineTotal, l.notes?.trim() || null,
        input.workerId, deviceId,
      );
      // Stock back on the shelf. Cost = refund unit (best
      // available approximation — the original cost is hard to
      // recover from a stock_movements aggregate). Total value
      // matches what we refunded.
      stockStmt.run(
        `sm-${uuidv4()}`, l.productId, input.locationId, l.quantity,
        input.shiftId, input.workerId, input.customerId,
        l.refundUnitPesewas, lineTotal,
        input.workerId, deviceId,
      );
    }

    // Refund path
    if (input.refundMethod === 'CASH') {
      // Money leaves the till. cash_counts CASH_DROP row tagged
      // with the return id so a forensic reader can follow the
      // money back to the return.
      db.prepare(
        `INSERT INTO cash_counts
           (id, shift_id, count_type, amount_pesewas, notes,
            created_by, device_id)
         VALUES (?, ?, 'CASH_DROP', ?, ?, ?, ?)`,
      ).run(
        `cc-${uuidv4()}`, input.shiftId, totalRefund,
        `customer-refund:${input.customerId}:${customerReturnId}`,
        input.workerId, deviceId,
      );
    } else {
      // CREDIT: write a synthetic customer_payments row with
      // payment_method='RETURN_CREDIT'. recordCustomerPayment does
      // the FIFO allocation against open credit sales and
      // reconciles the balance. Section 6 spells this out.
      const r = recordCustomerPayment(db, {
        customerId: input.customerId,
        shiftId: input.shiftId,
        amountPesewas: totalRefund,
        paymentMethod: 'RETURN_CREDIT',
        notes: `customer return ${customerReturnId}`,
      }, input.workerId, deviceId);
      newBalancePesewas = r.newBalancePesewas;
    }

    logAudit(db, {
      workerId: input.workerId,
      action: 'CUSTOMER_RETURN_RECORDED',
      entityType: 'customer_returns',
      entityId: customerReturnId,
      afterValue: {
        customerId: input.customerId,
        refundMethod: input.refundMethod,
        totalRefundPesewas: totalRefund,
        lineCount: input.lines.length,
      },
      deviceId,
    });
  });
  tx();

  return { customerReturnId, totalRefundPesewas: totalRefund, newBalancePesewas };
}

// --- reads -------------------------------------------------------------

export interface CustomerReturnRow {
  id: string;
  customerId: string;
  refundMethod: RefundMethod;
  totalRefundPesewas: number;
  notes: string | null;
  createdAt: string;
  createdBy: string;
  createdByName: string | null;
  lineCount: number;
}

export function listReturnsForCustomer(
  db: Database, customerId: string, limit = 30,
): CustomerReturnRow[] {
  return db.prepare(
    `SELECT cr.id, cr.customer_id AS customerId,
            cr.refund_method AS refundMethod,
            cr.total_refund_pesewas AS totalRefundPesewas,
            cr.notes, cr.created_at AS createdAt,
            cr.created_by AS createdBy,
            w.full_name AS createdByName,
            (SELECT COUNT(*) FROM customer_return_lines crl
              WHERE crl.customer_return_id = cr.id) AS lineCount
       FROM customer_returns cr
       LEFT JOIN workers w ON w.id = cr.created_by
      WHERE cr.customer_id = ?
      ORDER BY cr.created_at DESC LIMIT ?`,
  ).all(customerId, limit) as CustomerReturnRow[];
}
