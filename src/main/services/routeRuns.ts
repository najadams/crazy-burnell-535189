// routeRuns.ts — Wave G chunk 3d. The per-day instance of a route.
//
// Lifecycle (simplified; the spec's RETURNING and the formal blind-
// cash-count interactions are deferred to Stage 4D when the driver
// client lands):
//
//   OPEN       — depot lead has opened today's run for a route +
//                 driver. Pending orders get assigned to it. Driver
//                 takes the goods off-system.
//   CLOSED     — driver returned, depot recorded the cash they
//                 handed over (closing_cash_pesewas). Orders still
//                 need to be converted to sales (via the existing
//                 pendingOrders.convertToSale flow).
//   RECONCILED — every assigned order has reached CONVERTED or
//                 CANCELLED; OWNER/SUPERVISOR has reviewed the
//                 closing cash against the sales' cash totals.
//
// The reopen path (CLOSED → OPEN) is one-shot per row, OWNER-gated,
// requires a reason; same shape as the day-lock reopen.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export type RouteRunStatus = 'OPEN' | 'RETURNING' | 'CLOSED' | 'RECONCILED';

export interface RouteRunRow {
  id: string;
  routeId: string;
  routeName: string;
  runDate: string;
  driverId: string;
  driverName: string;
  status: RouteRunStatus;
  openedAt: string;
  closedAt: string | null;
  closingCashPesewas: number | null;
  reconciledAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  notes: string | null;
  assignedOrderCount: number;
  convertedOrderCount: number;
  cancelledOrderCount: number;
}

// ----------------------------------------------------------------------
// Open
// ----------------------------------------------------------------------

export interface OpenRouteRunInput {
  routeId: string;
  runDate: string;        // YYYY-MM-DD
  driverId: string;       // any active worker can be a driver for now
  workerId: string;       // who opened it (usually the depot lead)
  notes?: string;
}

function validateRunDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Run date must be in YYYY-MM-DD format.');
  }
}

export function openRouteRun(
  db: Database, input: OpenRouteRunInput, deviceId: string,
): { routeRunId: string } {
  validateRunDate(input.runDate);

  // Route must exist + be active.
  const route = db.prepare(
    `SELECT id, name, active FROM routes WHERE id = ?`,
  ).get(input.routeId) as { id: string; name: string; active: 0 | 1 } | undefined;
  if (!route) throw new Error('Route not found.');
  if (!route.active) throw new Error(`Route "${route.name}" is archived — reactivate it first.`);

  // Driver must exist + be active.
  const driver = db.prepare(
    `SELECT id, full_name AS fullName FROM workers WHERE id = ? AND active = 1`,
  ).get(input.driverId) as { id: string; fullName: string } | undefined;
  if (!driver) throw new Error('Driver not found or inactive.');

  // UNIQUE(route_id, run_date) catches the schema-level case; we
  // surface a friendlier message before hitting the constraint.
  const existing = db.prepare(
    `SELECT id FROM route_runs WHERE route_id = ? AND run_date = ?`,
  ).get(input.routeId, input.runDate) as { id: string } | undefined;
  if (existing) {
    throw new Error(`A run for ${route.name} on ${input.runDate} already exists.`);
  }

  const id = `rrun-${uuidv4()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO route_runs
         (id, route_id, run_date, driver_id, notes,
          created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.routeId, input.runDate, input.driverId,
      input.notes?.trim() || null,
      input.workerId, input.workerId, deviceId,
    );

    logAudit(db, {
      workerId: input.workerId,
      action: 'ROUTE_RUN_OPENED',
      entityType: 'route_runs',
      entityId: id,
      afterValue: {
        routeId: input.routeId, routeName: route.name,
        runDate: input.runDate, driverId: input.driverId,
      },
      deviceId,
    });
  });
  tx();
  return { routeRunId: id };
}

// ----------------------------------------------------------------------
// Reads
// ----------------------------------------------------------------------

const SELECT_RUN_BASE = `
  SELECT rr.id, rr.route_id AS routeId, r.name AS routeName,
         rr.run_date AS runDate, rr.driver_id AS driverId,
         w.full_name AS driverName,
         rr.status, rr.opened_at AS openedAt,
         rr.closed_at AS closedAt,
         rr.closing_cash_pesewas AS closingCashPesewas,
         rr.reconciled_at AS reconciledAt,
         rr.reopened_at AS reopenedAt,
         rr.reopen_reason AS reopenReason,
         rr.notes,
         (SELECT COUNT(*) FROM pending_orders po
           WHERE po.assigned_route_run_id = rr.id) AS assignedOrderCount,
         (SELECT COUNT(*) FROM pending_orders po
           WHERE po.assigned_route_run_id = rr.id AND po.status = 'CONVERTED') AS convertedOrderCount,
         (SELECT COUNT(*) FROM pending_orders po
           WHERE po.assigned_route_run_id = rr.id AND po.status = 'CANCELLED') AS cancelledOrderCount
    FROM route_runs rr
    JOIN routes  r ON r.id = rr.route_id
    JOIN workers w ON w.id = rr.driver_id`;

export interface ListRouteRunsInput {
  status?: RouteRunStatus | 'OPEN_OR_CLOSED';
  runDate?: string;
  limit?: number;
}

export function listRouteRuns(
  db: Database, input: ListRouteRunsInput = {},
): RouteRunRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.status === 'OPEN_OR_CLOSED') {
    where.push("rr.status IN ('OPEN','RETURNING','CLOSED')");
  } else if (input.status) {
    where.push('rr.status = ?'); params.push(input.status);
  }
  if (input.runDate) { where.push('rr.run_date = ?'); params.push(input.runDate); }

  const sql = `${SELECT_RUN_BASE}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY rr.run_date DESC, rr.opened_at DESC
    LIMIT ?`;
  params.push(input.limit ?? 50);
  return db.prepare(sql).all(...params) as RouteRunRow[];
}

// "What runs do I (the logged-in driver) have open right now?"
// Used by the driver-side UI to land directly on actionable work.
export function listRunsForDriver(
  db: Database, driverWorkerId: string,
): RouteRunRow[] {
  return db.prepare(`${SELECT_RUN_BASE}
    WHERE rr.driver_id = ? AND rr.status IN ('OPEN','RETURNING')
    ORDER BY rr.run_date DESC, rr.opened_at DESC`).all(driverWorkerId) as RouteRunRow[];
}

export function getRouteRun(db: Database, routeRunId: string): RouteRunRow {
  const row = db.prepare(`${SELECT_RUN_BASE} WHERE rr.id = ?`).get(routeRunId) as RouteRunRow | undefined;
  if (!row) throw new Error('Route run not found.');
  return row;
}

// ----------------------------------------------------------------------
// Assign / unassign pending orders
// ----------------------------------------------------------------------

export function assignOrderToRun(
  db: Database,
  input: { pendingOrderId: string; routeRunId: string; workerId: string },
  deviceId: string,
): void {
  const order = db.prepare(
    `SELECT id, status, customer_id AS customerId,
            assigned_route_run_id AS assignedRouteRunId
       FROM pending_orders WHERE id = ?`,
  ).get(input.pendingOrderId) as
    | { id: string; status: string; customerId: string; assignedRouteRunId: string | null }
    | undefined;
  if (!order) throw new Error('Pending order not found.');
  if (order.status !== 'CREATED') {
    throw new Error(`Only CREATED orders can be assigned to a run (current: ${order.status}).`);
  }
  if (order.assignedRouteRunId) {
    throw new Error('Order is already assigned to a run.');
  }

  const run = db.prepare(
    `SELECT id, status FROM route_runs WHERE id = ?`,
  ).get(input.routeRunId) as { id: string; status: string } | undefined;
  if (!run) throw new Error('Route run not found.');
  if (run.status !== 'OPEN') {
    throw new Error(`Cannot assign to a run with status ${run.status}.`);
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE pending_orders
          SET assigned_route_run_id = ?,
              status = 'ASSIGNED',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(input.routeRunId, input.workerId, input.pendingOrderId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'PENDING_ORDER_ASSIGNED',
      entityType: 'pending_orders',
      entityId: input.pendingOrderId,
      afterValue: { routeRunId: input.routeRunId },
      deviceId,
    });
  });
  tx();
}

export function unassignOrderFromRun(
  db: Database,
  input: { pendingOrderId: string; workerId: string },
  deviceId: string,
): void {
  const order = db.prepare(
    `SELECT id, status, assigned_route_run_id AS assignedRouteRunId
       FROM pending_orders WHERE id = ?`,
  ).get(input.pendingOrderId) as
    | { id: string; status: string; assignedRouteRunId: string | null }
    | undefined;
  if (!order) throw new Error('Pending order not found.');
  if (order.status !== 'ASSIGNED') {
    throw new Error(`Only ASSIGNED orders can be unassigned (current: ${order.status}).`);
  }

  // The run must still be OPEN — unassigning out of a CLOSED run
  // would break the closing-cash math. If the driver hasn't returned
  // yet, OWNER can unassign + reassign freely.
  if (order.assignedRouteRunId) {
    const run = db.prepare(
      `SELECT status FROM route_runs WHERE id = ?`,
    ).get(order.assignedRouteRunId) as { status: string } | undefined;
    if (run && run.status !== 'OPEN') {
      throw new Error('Cannot unassign from a run that is no longer OPEN.');
    }
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE pending_orders
          SET assigned_route_run_id = NULL,
              status = 'CREATED',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(input.workerId, input.pendingOrderId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'PENDING_ORDER_UNASSIGNED',
      entityType: 'pending_orders',
      entityId: input.pendingOrderId,
      beforeValue: { routeRunId: order.assignedRouteRunId },
      deviceId,
    });
  });
  tx();
}

// ----------------------------------------------------------------------
// Close
// ----------------------------------------------------------------------

export interface CloseRouteRunInput {
  routeRunId: string;
  closingCashPesewas: number;
  workerId: string;
  notes?: string;
}

export function closeRouteRun(
  db: Database, input: CloseRouteRunInput, deviceId: string,
): void {
  if (!Number.isInteger(input.closingCashPesewas) || input.closingCashPesewas < 0) {
    throw new Error('Closing cash must be a non-negative whole number of pesewas.');
  }
  const run = db.prepare(
    `SELECT id, status, route_id AS routeId
       FROM route_runs WHERE id = ?`,
  ).get(input.routeRunId) as { id: string; status: string; routeId: string } | undefined;
  if (!run) throw new Error('Route run not found.');
  if (run.status !== 'OPEN' && run.status !== 'RETURNING') {
    throw new Error(`Cannot close a run with status ${run.status}.`);
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE route_runs
          SET status = 'CLOSED',
              closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              closed_by = ?,
              closing_cash_pesewas = ?,
              notes = COALESCE(?, notes),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(
      input.workerId, input.closingCashPesewas,
      input.notes?.trim() || null,
      input.workerId, input.routeRunId,
    );

    logAudit(db, {
      workerId: input.workerId,
      action: 'ROUTE_RUN_CLOSED',
      entityType: 'route_runs',
      entityId: input.routeRunId,
      afterValue: { closingCashPesewas: input.closingCashPesewas },
      deviceId,
    });
  });
  tx();
}

// ----------------------------------------------------------------------
// Reconcile
// ----------------------------------------------------------------------

export interface ReconcileRouteRunInput {
  routeRunId: string;
  workerId: string;
  notes?: string;
}

export function reconcileRouteRun(
  db: Database, input: ReconcileRouteRunInput, deviceId: string,
): void {
  const run = db.prepare(
    `SELECT id, status FROM route_runs WHERE id = ?`,
  ).get(input.routeRunId) as { id: string; status: string } | undefined;
  if (!run) throw new Error('Route run not found.');
  if (run.status !== 'CLOSED') {
    throw new Error(`Cannot reconcile a run with status ${run.status}.`);
  }

  // Every assigned order must have reached a terminal state.
  const pending = db.prepare(
    `SELECT COUNT(*) AS n FROM pending_orders
      WHERE assigned_route_run_id = ?
        AND status NOT IN ('CONVERTED','CANCELLED')`,
  ).get(input.routeRunId) as { n: number };
  if (pending.n > 0) {
    throw new Error(`${pending.n} assigned order(s) are still in flight (not converted or cancelled). Reconcile blocked.`);
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE route_runs
          SET status = 'RECONCILED',
              reconciled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              reconciled_by = ?,
              reconciliation_notes = COALESCE(?, reconciliation_notes),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(
      input.workerId, input.notes?.trim() || null,
      input.workerId, input.routeRunId,
    );

    logAudit(db, {
      workerId: input.workerId,
      action: 'ROUTE_RUN_RECONCILED',
      entityType: 'route_runs',
      entityId: input.routeRunId,
      afterValue: { notes: input.notes?.trim() || null },
      deviceId,
    });
  });
  tx();
}

// ----------------------------------------------------------------------
// Reopen (CLOSED → back to OPEN, one-shot per row)
// ----------------------------------------------------------------------

export interface ReopenRouteRunInput {
  routeRunId: string;
  workerId: string;
  reason: string;
}

export function reopenRouteRun(
  db: Database, input: ReopenRouteRunInput, deviceId: string,
): void {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new Error('A reopen reason is required (at least a few characters).');
  }
  const run = db.prepare(
    `SELECT id, status, reopened_at AS reopenedAt FROM route_runs WHERE id = ?`,
  ).get(input.routeRunId) as { id: string; status: string; reopenedAt: string | null } | undefined;
  if (!run) throw new Error('Route run not found.');
  if (run.status === 'RECONCILED') {
    throw new Error('Cannot reopen a reconciled run.');
  }
  if (run.status !== 'CLOSED') {
    throw new Error(`Cannot reopen a run with status ${run.status}.`);
  }
  if (run.reopenedAt) {
    throw new Error('This run has already been reopened once and cannot be reopened again.');
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE route_runs
          SET status = 'OPEN',
              reopened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              reopened_by = ?,
              reopen_reason = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(input.workerId, input.reason.trim(), input.workerId, input.routeRunId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'ROUTE_RUN_REOPENED',
      entityType: 'route_runs',
      entityId: input.routeRunId,
      afterValue: { reason: input.reason.trim() },
      deviceId,
    });
  });
  tx();
}
