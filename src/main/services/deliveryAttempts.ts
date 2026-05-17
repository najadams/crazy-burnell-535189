// deliveryAttempts.ts — Wave G chunk 4a. Section 18.3 + 18.5.
//
// One row per pending_order capturing the driver's outcome at the
// stop. Recorded either by the driver from the driver client (Stage
// 4D, not built yet) or by the depot lead at debrief when the
// driver returns. UNIQUE(pending_order_id) means re-recording for
// the same order updates the existing row rather than creating a
// new one — the depot maintains a single source of truth per
// delivery.
//
// This service writes the data; downstream processing (firing the
// real customer_returns entity from return_intent_lines, allocating
// collected_cash to a sale via convertToSale) happens elsewhere and
// is independent of this row's existence. The row's purpose is the
// forensic trail: "the driver attempted delivery X at time Y with
// outcome Z and collected this much cash and these empties."

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export type DeliveryOutcome = 'DELIVERED' | 'PARTIAL' | 'REFUSED' | 'MISSED';

export interface DeliveryAttemptRow {
  id: string;
  routeRunId: string;
  pendingOrderId: string;
  customerId: string;
  customerName: string;
  attemptedAt: string;
  outcome: DeliveryOutcome;
  collectedCashPesewas: number;
  collectedEmptiesCount: number;
  returnIntentLines: string | null;
  notes: string | null;
}

export interface RecordDeliveryAttemptInput {
  routeRunId: string;
  pendingOrderId: string;
  workerId: string;            // who's recording (depot lead today, driver later)
  outcome: DeliveryOutcome;
  collectedCashPesewas?: number;
  collectedEmptiesCount?: number;
  returnIntentLines?: string;  // JSON
  notes?: string;
}

// Upsert: if a row already exists for this pending_order, update.
// Otherwise insert. Either way, write an audit row with the previous
// outcome if any. Validates that the order is actually assigned to
// the given run.
export function recordDeliveryAttempt(
  db: Database, input: RecordDeliveryAttemptInput, deviceId: string,
): { deliveryAttemptId: string } {
  const cash = input.collectedCashPesewas ?? 0;
  const empties = input.collectedEmptiesCount ?? 0;
  if (!Number.isInteger(cash) || cash < 0) {
    throw new Error('Collected cash must be a non-negative whole number of pesewas.');
  }
  if (!Number.isInteger(empties) || empties < 0) {
    throw new Error('Collected empties count must be a non-negative whole number.');
  }
  // For MISSED/REFUSED, cash and empties should be zero. Don't hard-
  // reject but warn-with-truncate: the schema CHECK still enforces
  // non-negative; service code keeps the data sensible.
  if ((input.outcome === 'MISSED' || input.outcome === 'REFUSED')
      && (cash > 0 || empties > 0)) {
    throw new Error(
      `Outcome ${input.outcome} cannot carry collected cash or empties — record DELIVERED or PARTIAL instead, or set those fields to 0.`,
    );
  }

  // Confirm the order is assigned to this run (and the run + order
  // exist + the customer linkage matches).
  const order = db.prepare(
    `SELECT id, status, customer_id AS customerId,
            assigned_route_run_id AS assignedRouteRunId
       FROM pending_orders WHERE id = ?`,
  ).get(input.pendingOrderId) as
    | { id: string; status: string; customerId: string; assignedRouteRunId: string | null }
    | undefined;
  if (!order) throw new Error('Pending order not found.');
  if (order.assignedRouteRunId !== input.routeRunId) {
    throw new Error('Order is not assigned to this route run.');
  }

  const run = db.prepare(
    `SELECT id, status FROM route_runs WHERE id = ?`,
  ).get(input.routeRunId) as { id: string; status: string } | undefined;
  if (!run) throw new Error('Route run not found.');
  if (run.status === 'RECONCILED') {
    throw new Error('Cannot record a delivery on a reconciled run.');
  }

  // Existing attempt? Update; otherwise insert.
  const existing = db.prepare(
    `SELECT id, outcome FROM delivery_attempts WHERE pending_order_id = ?`,
  ).get(input.pendingOrderId) as { id: string; outcome: DeliveryOutcome } | undefined;

  const id = existing?.id ?? `da-${uuidv4()}`;

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE delivery_attempts
            SET attempted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                outcome = ?,
                collected_cash_pesewas = ?,
                collected_empties_count = ?,
                return_intent_lines = ?,
                notes = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                updated_by = ?
          WHERE id = ?`,
      ).run(
        input.outcome, cash, empties,
        input.returnIntentLines ?? null,
        input.notes?.trim() || null,
        input.workerId, id,
      );
    } else {
      db.prepare(
        `INSERT INTO delivery_attempts
           (id, route_run_id, pending_order_id, customer_id,
            outcome, collected_cash_pesewas, collected_empties_count,
            return_intent_lines, notes,
            created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.routeRunId, input.pendingOrderId, order.customerId,
        input.outcome, cash, empties,
        input.returnIntentLines ?? null,
        input.notes?.trim() || null,
        input.workerId, input.workerId, deviceId,
      );
    }

    logAudit(db, {
      workerId: input.workerId,
      action: existing ? 'DELIVERY_ATTEMPT_UPDATED' : 'DELIVERY_ATTEMPT_RECORDED',
      entityType: 'delivery_attempts',
      entityId: id,
      ...(existing ? { beforeValue: { outcome: existing.outcome } } : {}),
      afterValue: {
        routeRunId: input.routeRunId,
        pendingOrderId: input.pendingOrderId,
        outcome: input.outcome,
        collectedCashPesewas: cash,
        collectedEmptiesCount: empties,
      },
      deviceId,
    });
  });
  tx();
  return { deliveryAttemptId: id };
}

export function listAttemptsForRun(
  db: Database, routeRunId: string,
): DeliveryAttemptRow[] {
  return db.prepare(
    `SELECT da.id, da.route_run_id AS routeRunId,
            da.pending_order_id AS pendingOrderId,
            da.customer_id AS customerId,
            c.display_name AS customerName,
            da.attempted_at AS attemptedAt,
            da.outcome,
            da.collected_cash_pesewas AS collectedCashPesewas,
            da.collected_empties_count AS collectedEmptiesCount,
            da.return_intent_lines AS returnIntentLines,
            da.notes
       FROM delivery_attempts da
       JOIN customers c ON c.id = da.customer_id
      WHERE da.route_run_id = ?
      ORDER BY da.attempted_at ASC`,
  ).all(routeRunId) as DeliveryAttemptRow[];
}

export function getAttemptForOrder(
  db: Database, pendingOrderId: string,
): DeliveryAttemptRow | null {
  const r = db.prepare(
    `SELECT da.id, da.route_run_id AS routeRunId,
            da.pending_order_id AS pendingOrderId,
            da.customer_id AS customerId,
            c.display_name AS customerName,
            da.attempted_at AS attemptedAt,
            da.outcome,
            da.collected_cash_pesewas AS collectedCashPesewas,
            da.collected_empties_count AS collectedEmptiesCount,
            da.return_intent_lines AS returnIntentLines,
            da.notes
       FROM delivery_attempts da
       JOIN customers c ON c.id = da.customer_id
      WHERE da.pending_order_id = ?`,
  ).get(pendingOrderId) as DeliveryAttemptRow | undefined;
  return r ?? null;
}
