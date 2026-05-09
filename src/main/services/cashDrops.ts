// cashDrops.ts — record cash leaving the till mid-shift.
//
// CLAUDE.md section 8: drops to owner / supplier / runner / customer-
// refund all reduce expected closing cash. We record a cash_counts row
// with count_type='CASH_DROP' and a reason in notes. The closing-shift
// math (in shifts.ts closeShift) already subtracts SUM(CASH_DROP)
// from expected.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export type CashDropReason =
  | 'OWNER_TAKE'
  | 'SUPPLIER_PAYMENT'
  | 'RUNNER_ADVANCE'
  | 'CUSTOMER_REFUND'
  | 'EXPENSE'
  | 'OTHER';

export function recordCashDrop(
  db: Database,
  shiftId: string, workerId: string,
  amountPesewas: number, reason: CashDropReason, note: string,
  deviceId: string,
): { dropId: string } {
  if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
    throw new Error('Drop amount must be a positive whole number of pesewas.');
  }
  // Reason note: "OWNER_TAKE: bought bread" — keeps the enum machine-
  // readable and the human note alongside.
  const noteText = note.trim()
    ? `${reason}: ${note.trim()}`
    : reason;

  const dropId = `cc-${uuidv4()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO cash_counts
         (id, shift_id, count_type, amount_pesewas, notes,
          created_by, device_id)
       VALUES (?, ?, 'CASH_DROP', ?, ?, ?, ?)`,
    ).run(dropId, shiftId, amountPesewas, noteText, workerId, deviceId);

    logAudit(db, {
      workerId,
      action: 'CASH_DROP_RECORDED',
      entityType: 'cash_counts',
      entityId: dropId,
      afterValue: { amountPesewas, reason, note: note.trim() || null },
      deviceId,
    });
  });
  tx();
  return { dropId };
}
