// stockReceipts.ts — record a delivery from a supplier as N positive
// stock_movements rows. The spec doesn't have a "stock_receipts header"
// table; receipts are flat positive movements per product.
//
// Wave: supplier AP. If `payable` is supplied, the receipt also writes
// a `supplier_invoices` row in the same transaction so the commercial
// side is captured alongside the goods inflow. Receipts without a
// `payable` block (or with `supplierId === null`) are recorded as
// goods-only and create no payable.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';
import { reconcileSupplierBalance } from './supplierPayments.js';

export interface ReceiptLine {
  productId: string;
  quantity: number;            // positive units (canonical unit)
  unitCostPesewas: number;     // cost paid this delivery; snapshot per line
}

export interface ReceiptPayableInput {
  // null/undefined => COD (paid at delivery, no open balance)
  // > 0           => net-N terms; invoice_payable=1
  paymentTermsDays: number;
  invoiceNumber?: string;            // supplier's own invoice ref
  invoiceDate?: string;              // ISO date; defaults to today
  // Override the total if it differs from sum(line.quantity * unitCost).
  // Useful when the supplier's invoice includes tax/discount lines that
  // aren't represented per-stock-line. If omitted, sum is used.
  totalPesewasOverride?: number;
}

export interface RecordReceiptInput {
  workerId: string;
  locationId: string;
  shiftId: string | null;      // optional — receipts can happen out of shift
  supplierId: string | null;
  lines: ReceiptLine[];
  notes?: string;
  payable?: ReceiptPayableInput;
}

export interface RecordReceiptResult {
  receiptId: string;
  lineCount: number;
  totalUnits: number;
  invoiceId: string | null;            // null when no payable was created
  totalPesewas: number;                // sum of line value or override
}

export function recordReceipt(
  db: Database, input: RecordReceiptInput, deviceId: string,
): RecordReceiptResult {
  if (input.lines.length === 0) {
    throw new Error('Receipt must have at least one line.');
  }
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw new Error('Line quantity must be a positive whole number.');
    }
    if (!Number.isInteger(l.unitCostPesewas) || l.unitCostPesewas < 0) {
      throw new Error('Unit cost must be a non-negative whole number of pesewas.');
    }
  }

  // The "receipt id" is just the audit_log id we'll write — there's no
  // dedicated receipts table per the spec. We bundle the related stock
  // movements under a single audit row so they can be queried together.
  const receiptId = `rcpt-${uuidv4()}`;

  const totalUnits = input.lines.reduce((s, l) => s + l.quantity, 0);
  const linesValue = input.lines.reduce(
    (s, l) => s + l.quantity * l.unitCostPesewas, 0,
  );
  const totalPesewas = input.payable?.totalPesewasOverride ?? linesValue;

  // Payable validity: needs a supplier (can't owe nobody) and a positive
  // total. Reject obvious mistakes early so the transaction below stays
  // tight.
  if (input.payable) {
    if (!input.supplierId) {
      throw new Error('Cannot create a payable without a supplierId.');
    }
    if (!Number.isInteger(totalPesewas) || totalPesewas <= 0) {
      throw new Error('Payable total must be a positive whole number of pesewas.');
    }
    if (input.payable.totalPesewasOverride !== undefined &&
        (!Number.isInteger(input.payable.totalPesewasOverride) ||
         input.payable.totalPesewasOverride <= 0)) {
      throw new Error('Payable totalPesewasOverride must be a positive whole number.');
    }
  }

  let invoiceId: string | null = null;

  const tx = db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO stock_movements
         (id, product_id, location_id, quantity, reason_code,
          shift_id, worker_id, customer_id,
          unit_cost_pesewas, total_value_pesewas,
          created_by, device_id)
       VALUES (?, ?, ?, ?, 'RECEIVED_FROM_SUPPLIER', ?, ?, NULL, ?, ?, ?, ?)`,
    );
    for (const l of input.lines) {
      stmt.run(
        `sm-${uuidv4()}`, l.productId, input.locationId, l.quantity,
        input.shiftId, input.workerId,
        l.unitCostPesewas, l.unitCostPesewas * l.quantity,
        input.workerId, deviceId,
      );
    }

    logAudit(db, {
      workerId: input.workerId,
      action: 'STOCK_RECEIVED',
      entityType: 'stock_receipts_virtual',
      entityId: receiptId,
      afterValue: {
        supplierId: input.supplierId,
        lineCount: input.lines.length,
        totalUnits,
        totalValuePesewas: linesValue,
        notes: input.notes ?? null,
      },
      deviceId,
    });

    if (input.payable && input.supplierId) {
      invoiceId = `si-${uuidv4()}`;
      const isPayable = input.payable.paymentTermsDays > 0 ? 1 : 0;
      const invoiceDate = input.payable.invoiceDate
        ?? new Date().toISOString().slice(0, 10);

      db.prepare(
        `INSERT INTO supplier_invoices
           (id, supplier_id, invoice_number, invoice_date,
            payment_terms_days, total_pesewas, is_payable,
            receipt_audit_id, notes,
            created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        invoiceId, input.supplierId,
        input.payable.invoiceNumber?.trim() || null,
        invoiceDate,
        input.payable.paymentTermsDays,
        totalPesewas, isPayable,
        receiptId, input.notes?.trim() || null,
        input.workerId, input.workerId, deviceId,
      );

      logAudit(db, {
        workerId: input.workerId,
        action: 'SUPPLIER_INVOICE_RECORDED',
        entityType: 'supplier_invoices',
        entityId: invoiceId,
        afterValue: {
          supplierId: input.supplierId,
          invoiceNumber: input.payable.invoiceNumber ?? null,
          totalPesewas,
          paymentTermsDays: input.payable.paymentTermsDays,
          isPayable,
          receiptId,
        },
        deviceId,
      });

      if (isPayable === 1) {
        reconcileSupplierBalance(db, input.supplierId, input.workerId);
      }
    }
  });
  tx();

  return {
    receiptId,
    lineCount: input.lines.length,
    totalUnits,
    invoiceId,
    totalPesewas,
  };
}
