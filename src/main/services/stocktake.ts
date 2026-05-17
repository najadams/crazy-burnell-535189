// stocktake.ts — cycle counting. Without periodic stocktakes, system
// stock drifts from reality silently and the depot doesn't notice
// until they try to commit an order they can't fulfil. Section 16
// Wave B.1 in the spec (ABC class on products) refines the workflow
// later; this is the v1 with manual product selection.
//
// Flow:
//   1. openStocktake() → session in status OPEN
//   2. For each product counted: recordCount(productId, countedQty).
//      Service snapshots the expected qty (from stock_movements sum)
//      at the moment of recording so close-time math is stable. Line
//      is upsert per (event, product).
//   3. listLinesForStocktake() → review what's been counted, deltas
//   4. closeStocktake() → for every non-zero delta, write a
//      STOCKTAKE_ADJUSTMENT stock_movements row (quantity = delta;
//      sign tells direction). If any abs(delta) exceeds the
//      large-delta threshold, supervisorApprovalId is required.
//
//   cancelStocktake() abandons the session; no adjustments written.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';
import { consumeSupervisorApproval } from './supervisorApprovals.js';

// Threshold above which a single line's |delta| requires supervisor
// approval to close the session. Owner-configurable later; for now
// this is a single hardcoded value — 10 units. Beverage wholesalers
// dealing in crates of 12-24 should reasonably hit this for genuine
// shrinkage events but not for normal noise.
const LARGE_DELTA_THRESHOLD = 10;

export interface StocktakeEventRow {
  id: string;
  locationId: string;
  locationName: string;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  notes: string | null;
  openedAt: string;
  openedBy: string;
  openedByName: string | null;
  closedAt: string | null;
  closedBy: string | null;
  cancelReason: string | null;
  lineCount: number;
  totalAbsoluteDelta: number;
}

export interface StocktakeLineRow {
  id: string;
  productId: string;
  productName: string;
  expectedQty: number;
  countedQty: number;
  deltaQty: number;
  notes: string | null;
  recordedAt: string;
}

// Helper: how much of `productId` is on hand at `locationId` right now?
function expectedQtyFor(db: Database, productId: string, locationId: string): number {
  const r = db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS qty
       FROM stock_movements
      WHERE product_id = ? AND location_id = ?`,
  ).get(productId, locationId) as { qty: number };
  return r.qty;
}

// --- open --------------------------------------------------------------

export interface OpenStocktakeInput {
  locationId: string;
  workerId: string;
  notes?: string;
}

export function openStocktake(
  db: Database, input: OpenStocktakeInput, deviceId: string,
): { stocktakeEventId: string } {
  // Refuse to open a second session against the same location while
  // an existing one is OPEN — would invite double-counting.
  const conflict = db.prepare(
    `SELECT id FROM stocktake_events WHERE location_id = ? AND status = 'OPEN'`,
  ).get(input.locationId) as { id: string } | undefined;
  if (conflict) {
    throw new Error('A stocktake session is already open for this location. Close or cancel it first.');
  }
  const loc = db.prepare(
    `SELECT id FROM locations WHERE id = ? AND active = 1`,
  ).get(input.locationId) as { id: string } | undefined;
  if (!loc) throw new Error('Location not found or inactive.');

  const id = `ste-${uuidv4()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO stocktake_events
         (id, location_id, opened_by, notes, device_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.locationId, input.workerId,
          input.notes?.trim() || null, deviceId);
    logAudit(db, {
      workerId: input.workerId,
      action: 'STOCKTAKE_OPENED',
      entityType: 'stocktake_events',
      entityId: id,
      afterValue: { locationId: input.locationId },
      deviceId,
    });
  });
  tx();
  return { stocktakeEventId: id };
}

// --- record count ------------------------------------------------------

export interface RecordCountInput {
  stocktakeEventId: string;
  productId: string;
  countedQty: number;
  notes?: string;
  workerId: string;
}

export function recordCount(
  db: Database, input: RecordCountInput, deviceId: string,
): { stocktakeLineId: string; expectedQty: number; deltaQty: number } {
  if (!Number.isInteger(input.countedQty) || input.countedQty < 0) {
    throw new Error('Counted quantity must be a non-negative whole number.');
  }
  const evt = db.prepare(
    `SELECT id, status, location_id AS locationId
       FROM stocktake_events WHERE id = ?`,
  ).get(input.stocktakeEventId) as
    | { id: string; status: string; locationId: string } | undefined;
  if (!evt) throw new Error('Stocktake session not found.');
  if (evt.status !== 'OPEN') {
    throw new Error(`Stocktake session is ${evt.status} — cannot record counts.`);
  }

  const product = db.prepare(`SELECT id FROM products WHERE id = ?`).get(input.productId);
  if (!product) throw new Error('Product not found.');

  const expected = expectedQtyFor(db, input.productId, evt.locationId);
  const delta = input.countedQty - expected;

  // Upsert: if a line already exists for this product in this session,
  // update it (re-counting allowed); otherwise insert.
  const existing = db.prepare(
    `SELECT id FROM stocktake_lines
      WHERE stocktake_event_id = ? AND product_id = ?`,
  ).get(input.stocktakeEventId, input.productId) as { id: string } | undefined;

  const id = existing?.id ?? `stl-${uuidv4()}`;

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE stocktake_lines
            SET expected_qty = ?, counted_qty = ?, notes = ?,
                recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                updated_by = ?
          WHERE id = ?`,
      ).run(expected, input.countedQty, input.notes?.trim() || null,
            input.workerId, id);
    } else {
      db.prepare(
        `INSERT INTO stocktake_lines
           (id, stocktake_event_id, product_id, expected_qty, counted_qty,
            notes, recorded_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.stocktakeEventId, input.productId, expected,
            input.countedQty, input.notes?.trim() || null,
            input.workerId, input.workerId, deviceId);
    }
    logAudit(db, {
      workerId: input.workerId,
      action: existing ? 'STOCKTAKE_COUNT_UPDATED' : 'STOCKTAKE_COUNT_RECORDED',
      entityType: 'stocktake_lines',
      entityId: id,
      afterValue: { productId: input.productId, expectedQty: expected,
                    countedQty: input.countedQty, deltaQty: delta },
      deviceId,
    });
  });
  tx();
  return { stocktakeLineId: id, expectedQty: expected, deltaQty: delta };
}

// --- reads --------------------------------------------------------------

export function listStocktakeEvents(
  db: Database, opts: { locationId?: string; limit?: number } = {},
): StocktakeEventRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.locationId) { where.push('e.location_id = ?'); params.push(opts.locationId); }
  const sql = `
    SELECT e.id, e.location_id AS locationId, l.name AS locationName,
           e.status, e.notes,
           e.opened_at AS openedAt, e.opened_by AS openedBy,
           w.full_name AS openedByName,
           e.closed_at AS closedAt, e.closed_by AS closedBy,
           e.cancel_reason AS cancelReason,
           (SELECT COUNT(*) FROM stocktake_lines sl WHERE sl.stocktake_event_id = e.id) AS lineCount,
           COALESCE((
             SELECT SUM(ABS(sl.delta_qty))
               FROM stocktake_lines sl WHERE sl.stocktake_event_id = e.id
           ), 0) AS totalAbsoluteDelta
      FROM stocktake_events e
      JOIN locations l ON l.id = e.location_id
      LEFT JOIN workers w ON w.id = e.opened_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.opened_at DESC LIMIT ?`;
  params.push(opts.limit ?? 30);
  return db.prepare(sql).all(...params) as StocktakeEventRow[];
}

export function listLinesForStocktake(
  db: Database, stocktakeEventId: string,
): StocktakeLineRow[] {
  return db.prepare(
    `SELECT sl.id, sl.product_id AS productId,
            p.name AS productName,
            sl.expected_qty AS expectedQty,
            sl.counted_qty AS countedQty,
            sl.delta_qty AS deltaQty,
            sl.notes, sl.recorded_at AS recordedAt
       FROM stocktake_lines sl
       JOIN products p ON p.id = sl.product_id
      WHERE sl.stocktake_event_id = ?
      ORDER BY sl.recorded_at ASC`,
  ).all(stocktakeEventId) as StocktakeLineRow[];
}

// --- close --------------------------------------------------------------

export interface CloseStocktakeInput {
  stocktakeEventId: string;
  workerId: string;
  // Required if any line has |delta| > LARGE_DELTA_THRESHOLD.
  supervisorApprovalId?: string;
}

export function closeStocktake(
  db: Database, input: CloseStocktakeInput, deviceId: string,
): { adjustmentsWritten: number; totalAbsoluteDelta: number } {
  const evt = db.prepare(
    `SELECT id, status, location_id AS locationId
       FROM stocktake_events WHERE id = ?`,
  ).get(input.stocktakeEventId) as
    | { id: string; status: string; locationId: string } | undefined;
  if (!evt) throw new Error('Stocktake session not found.');
  if (evt.status !== 'OPEN') {
    throw new Error(`Stocktake session is ${evt.status} — cannot close.`);
  }

  const lines = db.prepare(
    `SELECT sl.id, sl.product_id AS productId,
            sl.counted_qty AS countedQty,
            sl.expected_qty AS expectedQty,
            sl.delta_qty AS deltaQty,
            p.cost_price_pesewas AS costPesewas
       FROM stocktake_lines sl
       JOIN products p ON p.id = sl.product_id
      WHERE sl.stocktake_event_id = ?`,
  ).all(input.stocktakeEventId) as Array<{
    id: string; productId: string;
    countedQty: number; expectedQty: number; deltaQty: number;
    costPesewas: number;
  }>;
  if (lines.length === 0) {
    throw new Error('Stocktake has no recorded counts — nothing to adjust.');
  }

  const overThreshold = lines.filter((l) => Math.abs(l.deltaQty) > LARGE_DELTA_THRESHOLD);
  if (overThreshold.length > 0 && !input.supervisorApprovalId) {
    throw new Error(
      `${overThreshold.length} product(s) have a delta over ${LARGE_DELTA_THRESHOLD} units. A supervisor PIN is needed to close.`,
    );
  }

  let totalAbs = 0;
  let written = 0;
  const tx = db.transaction(() => {
    if (overThreshold.length > 0) {
      consumeSupervisorApproval(db, {
        approvalId: input.supervisorApprovalId!,
        expectedPurpose: 'STOCKTAKE_LARGE_DELTA',
        action: 'STOCKTAKE_CLOSED',
        entityId: input.stocktakeEventId,
      });
    }

    const stockStmt = db.prepare(
      `INSERT INTO stock_movements
         (id, product_id, location_id, quantity, reason_code,
          shift_id, worker_id, customer_id,
          unit_cost_pesewas, total_value_pesewas,
          created_by, device_id)
       VALUES (?, ?, ?, ?, 'STOCKTAKE_ADJUSTMENT',
               NULL, ?, NULL,
               ?, ?, ?, ?)`,
    );

    for (const l of lines) {
      totalAbs += Math.abs(l.deltaQty);
      if (l.deltaQty === 0) continue;
      stockStmt.run(
        `sm-${uuidv4()}`, l.productId, evt.locationId, l.deltaQty,
        input.workerId,
        l.costPesewas, l.costPesewas * Math.abs(l.deltaQty),
        input.workerId, deviceId,
      );
      written++;
    }

    db.prepare(
      `UPDATE stocktake_events
          SET status = 'CLOSED',
              closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              closed_by = ?,
              supervisor_approval_id = ?
        WHERE id = ?`,
    ).run(input.workerId, input.supervisorApprovalId ?? null, input.stocktakeEventId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'STOCKTAKE_CLOSED',
      entityType: 'stocktake_events',
      entityId: input.stocktakeEventId,
      afterValue: {
        adjustmentsWritten: written,
        totalAbsoluteDelta: totalAbs,
        overThresholdCount: overThreshold.length,
      },
      deviceId,
    });
  });
  tx();
  return { adjustmentsWritten: written, totalAbsoluteDelta: totalAbs };
}

export function cancelStocktake(
  db: Database,
  input: { stocktakeEventId: string; workerId: string; reason: string },
  deviceId: string,
): void {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new Error('Cancel reason required (at least a few characters).');
  }
  const evt = db.prepare(
    `SELECT id, status FROM stocktake_events WHERE id = ?`,
  ).get(input.stocktakeEventId) as { id: string; status: string } | undefined;
  if (!evt) throw new Error('Stocktake session not found.');
  if (evt.status !== 'OPEN') {
    throw new Error(`Stocktake session is ${evt.status} — cannot cancel.`);
  }
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE stocktake_events
          SET status = 'CANCELLED',
              cancel_reason = ?,
              cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(input.reason.trim(), input.stocktakeEventId);
    logAudit(db, {
      workerId: input.workerId,
      action: 'STOCKTAKE_CANCELLED',
      entityType: 'stocktake_events',
      entityId: input.stocktakeEventId,
      afterValue: { reason: input.reason.trim() },
      deviceId,
    });
  });
  tx();
}
