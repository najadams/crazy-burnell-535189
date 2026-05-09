// shifts.ts — open/close + cash counts.
//
// Spec section 8: a worker opens a shift with an OPENING cash count;
// closing is two-step blind count. For the demo we collapse closing to
// a single count compared against expected; the blind-count refinement
// is straightforward to add later (parent_count_id is already on
// cash_counts for it).

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export interface OpenShiftInput {
  workerId: string;
  locationId: string;
  openingAmountPesewas: number;
}

export function getCurrentShift(db: Database, workerId: string): {
  shiftId: string | null;
  openedAt: string | null;
  openingAmountPesewas: number | null;
} {
  const row = db.prepare(
    `SELECT s.id AS shiftId, s.opened_at AS openedAt,
            (SELECT amount_pesewas FROM cash_counts
              WHERE shift_id = s.id AND count_type = 'OPENING'
              LIMIT 1) AS openingAmountPesewas
       FROM shifts s
      WHERE s.worker_id = ? AND s.closed_at IS NULL
      ORDER BY s.opened_at DESC LIMIT 1`,
  ).get(workerId) as any;
  if (!row) return { shiftId: null, openedAt: null, openingAmountPesewas: null };
  return row;
}

export function openShift(
  db: Database, input: OpenShiftInput, deviceId: string,
): { shiftId: string } {
  if (!Number.isInteger(input.openingAmountPesewas) || input.openingAmountPesewas < 0) {
    throw new Error('Opening cash must be a non-negative whole number of pesewas.');
  }

  const existing = getCurrentShift(db, input.workerId);
  if (existing.shiftId) {
    throw new Error('You already have an open shift. Close it before opening a new one.');
  }

  const shiftId = `shift-${uuidv4()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO shifts (id, worker_id, location_id, device_id)
       VALUES (?, ?, ?, ?)`,
    ).run(shiftId, input.workerId, input.locationId, deviceId);
    db.prepare(
      `INSERT INTO cash_counts
         (id, shift_id, count_type, amount_pesewas, created_by, device_id)
       VALUES (?, ?, 'OPENING', ?, ?, ?)`,
    ).run(`cc-${uuidv4()}`, shiftId, input.openingAmountPesewas, input.workerId, deviceId);
    logAudit(db, {
      workerId: input.workerId,
      action: 'SHIFT_OPENED',
      entityType: 'shifts',
      entityId: shiftId,
      afterValue: { openingAmountPesewas: input.openingAmountPesewas },
      deviceId,
    });
  });
  tx();
  return { shiftId };
}

export function closeShift(
  db: Database, shiftId: string, workerId: string,
  countedAmountPesewas: number, deviceId: string,
): { expectedAmountPesewas: number; deltaPesewas: number } {
  if (!Number.isInteger(countedAmountPesewas) || countedAmountPesewas < 0) {
    throw new Error('Counted cash must be a non-negative whole number of pesewas.');
  }
  const shift = db.prepare(
    `SELECT id, closed_at AS closedAt, worker_id AS workerId
       FROM shifts WHERE id = ?`,
  ).get(shiftId) as { id: string; closedAt: string | null; workerId: string } | undefined;
  if (!shift) throw new Error('Shift not found.');
  if (shift.closedAt) throw new Error('Shift is already closed.');
  if (shift.workerId !== workerId) throw new Error('You can only close your own shift.');

  // Expected = OPENING + cash sales − cash drops.
  const opening = (db.prepare(
    `SELECT amount_pesewas AS v FROM cash_counts
      WHERE shift_id = ? AND count_type = 'OPENING'`,
  ).get(shiftId) as any)?.v ?? 0;

  const cashSales = (db.prepare(
    `SELECT COALESCE(SUM(total_pesewas), 0) AS v
       FROM sales
      WHERE shift_id = ? AND voided = 0
        AND payment_method = 'CASH'`,
  ).get(shiftId) as any).v;

  const cashDrops = (db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS v
       FROM cash_counts
      WHERE shift_id = ? AND count_type = 'CASH_DROP'`,
  ).get(shiftId) as any).v;

  // Customer payments received in cash during this shift count toward
  // expected closing cash. Non-cash payments (MoMo/bank) don't.
  const cashPayments = (db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS v
       FROM customer_payments
      WHERE shift_id = ? AND payment_method = 'CASH'`,
  ).get(shiftId) as any).v;

  const expected = opening + cashSales + cashPayments - cashDrops;
  const delta = countedAmountPesewas - expected;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO cash_counts
         (id, shift_id, count_type, amount_pesewas, notes, created_by, device_id)
       VALUES (?, ?, 'CLOSING', ?, ?, ?, ?)`,
    ).run(
      `cc-${uuidv4()}`, shiftId, countedAmountPesewas,
      `expected=${expected}; delta=${delta}`, workerId, deviceId,
    );
    db.prepare(
      `UPDATE shifts SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(shiftId);
    logAudit(db, {
      workerId, action: 'SHIFT_CLOSED',
      entityType: 'shifts', entityId: shiftId,
      afterValue: { expected, counted: countedAmountPesewas, delta },
      deviceId,
    });
  });
  tx();

  return { expectedAmountPesewas: expected, deltaPesewas: delta };
}
