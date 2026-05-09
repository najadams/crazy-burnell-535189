// stockReceipts.ts — record a delivery from a supplier as N positive
// stock_movements rows. The spec doesn't have a "stock_receipts header"
// table; receipts are flat positive movements per product.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export interface ReceiptLine {
  productId: string;
  quantity: number;            // positive units (canonical unit)
  unitCostPesewas: number;     // cost paid this delivery; snapshot per line
}

export interface RecordReceiptInput {
  workerId: string;
  locationId: string;
  shiftId: string | null;      // optional — receipts can happen out of shift
  supplierId: string | null;
  lines: ReceiptLine[];
  notes?: string;
}

export function recordReceipt(
  db: Database, input: RecordReceiptInput, deviceId: string,
): { receiptId: string; lineCount: number; totalUnits: number } {
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
        totalUnits: input.lines.reduce((s, l) => s + l.quantity, 0),
        totalValuePesewas: input.lines.reduce(
          (s, l) => s + l.quantity * l.unitCostPesewas, 0,
        ),
        notes: input.notes ?? null,
      },
      deviceId,
    });
  });
  tx();

  return {
    receiptId,
    lineCount: input.lines.length,
    totalUnits: input.lines.reduce((s, l) => s + l.quantity, 0),
  };
}
