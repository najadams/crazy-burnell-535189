// routes.ts — manage the stable customer rotations the depot runs.
// Wave G chunk 3. Section 18.3 of CLAUDE.md.
//
// A `route` is the rotation definition (name + which weekdays it
// runs). `route_stops` is the ordered list of customers on that
// rotation. The chunk-3b functions (openRouteRun, closeRouteRun,
// listRouteRuns) and chunk-4 functions (assign pending orders to a
// run, delivery_attempts) are not in this file yet — this is the
// rotation-definition surface only.
//
// Stop order is kept dense (no gaps) on reorder so the UI doesn't
// have to deal with arbitrary integer-ordering edge cases. New stops
// append to the end; remove + reorder both renumber the surviving
// stops to a 1..N sequence.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export interface RouteRow {
  id: string;
  name: string;
  weekdayPattern: string;
  active: boolean;
  notes: string | null;
  createdAt: string;
  stopCount: number;
}

export interface RouteStopRow {
  id: string;
  routeId: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  stopOrder: number;
}

// ----------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------

export interface CreateRouteInput {
  name: string;
  weekdayPattern?: string;
  notes?: string;
  workerId: string;
}

const ALLOWED_WEEKDAYS = ['MON','TUE','WED','THU','FRI','SAT','SUN'];

function validateWeekdayPattern(p: string): void {
  if (p === '') return;
  const parts = p.split(',').map((s) => s.trim().toUpperCase());
  for (const part of parts) {
    if (!ALLOWED_WEEKDAYS.includes(part)) {
      throw new Error(`Invalid weekday code "${part}". Allowed: ${ALLOWED_WEEKDAYS.join(', ')}.`);
    }
  }
}

export function createRoute(
  db: Database, input: CreateRouteInput, deviceId: string,
): { routeId: string } {
  const name = input.name.trim();
  if (name.length < 2) {
    throw new Error('Route name must be at least 2 characters.');
  }
  const pattern = (input.weekdayPattern ?? '').trim().toUpperCase();
  validateWeekdayPattern(pattern);

  const routeId = `rt-${uuidv4()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO routes (id, name, weekday_pattern, notes,
                           created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(routeId, name, pattern, input.notes?.trim() || null,
          input.workerId, input.workerId, deviceId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'ROUTE_CREATED',
      entityType: 'routes',
      entityId: routeId,
      afterValue: { name, weekdayPattern: pattern },
      deviceId,
    });
  });
  tx();
  return { routeId };
}

export function listRoutes(
  db: Database, opts: { includeArchived?: boolean } = {},
): RouteRow[] {
  const where = opts.includeArchived ? '' : 'WHERE r.active = 1';
  const rows = db.prepare(
    `SELECT r.id, r.name,
            r.weekday_pattern AS weekdayPattern,
            r.active, r.notes,
            r.created_at AS createdAt,
            (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id) AS stopCount
       FROM routes r
       ${where}
       ORDER BY r.active DESC, r.name ASC`,
  ).all() as Array<any>;
  return rows.map((r) => ({ ...r, active: !!r.active })) as RouteRow[];
}

export function archiveRoute(
  db: Database,
  input: { routeId: string; workerId: string },
  deviceId: string,
): void {
  const row = db.prepare(
    `SELECT id, name, active FROM routes WHERE id = ?`,
  ).get(input.routeId) as { id: string; name: string; active: 0 | 1 } | undefined;
  if (!row) throw new Error('Route not found.');
  if (!row.active) throw new Error('Route is already archived.');

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE routes SET active = 0,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_by = ?
        WHERE id = ?`,
    ).run(input.workerId, input.routeId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'ROUTE_ARCHIVED',
      entityType: 'routes',
      entityId: input.routeId,
      beforeValue: { name: row.name, active: true },
      afterValue:  { active: false },
      deviceId,
    });
  });
  tx();
}

export function reactivateRoute(
  db: Database,
  input: { routeId: string; workerId: string },
  deviceId: string,
): void {
  const row = db.prepare(`SELECT id, active FROM routes WHERE id = ?`).get(input.routeId) as
    | { id: string; active: 0 | 1 } | undefined;
  if (!row) throw new Error('Route not found.');
  if (row.active) throw new Error('Route is already active.');

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE routes SET active = 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_by = ?
        WHERE id = ?`,
    ).run(input.workerId, input.routeId);
    logAudit(db, {
      workerId: input.workerId,
      action: 'ROUTE_REACTIVATED',
      entityType: 'routes',
      entityId: input.routeId,
      afterValue: { active: true },
      deviceId,
    });
  });
  tx();
}

// ----------------------------------------------------------------------
// Route stops
// ----------------------------------------------------------------------

export function listStopsForRoute(
  db: Database, routeId: string,
): RouteStopRow[] {
  return db.prepare(
    `SELECT rs.id, rs.route_id AS routeId,
            rs.customer_id AS customerId,
            c.display_name AS customerName,
            c.phone AS customerPhone,
            rs.stop_order AS stopOrder
       FROM route_stops rs
       JOIN customers c ON c.id = rs.customer_id
      WHERE rs.route_id = ?
      ORDER BY rs.stop_order ASC`,
  ).all(routeId) as RouteStopRow[];
}

export function addStop(
  db: Database,
  input: { routeId: string; customerId: string; workerId: string },
  deviceId: string,
): { stopId: string; stopOrder: number } {
  // Route must exist + be active. Customer must exist + not blocked.
  const route = db.prepare(
    `SELECT id, active FROM routes WHERE id = ?`,
  ).get(input.routeId) as { id: string; active: 0 | 1 } | undefined;
  if (!route) throw new Error('Route not found.');
  if (!route.active) throw new Error('Cannot add stops to an archived route.');

  const cust = db.prepare(
    `SELECT id, blocked, display_name AS displayName FROM customers WHERE id = ?`,
  ).get(input.customerId) as { id: string; blocked: 0 | 1; displayName: string } | undefined;
  if (!cust) throw new Error('Customer not found.');
  if (cust.blocked) {
    throw new Error(`${cust.displayName} is blocked — cannot be added to a route.`);
  }

  // UNIQUE(route_id, customer_id) prevents duplicates at the DB level
  // but surface a clearer error than the constraint message.
  const exists = db.prepare(
    `SELECT id FROM route_stops WHERE route_id = ? AND customer_id = ?`,
  ).get(input.routeId, input.customerId) as { id: string } | undefined;
  if (exists) {
    throw new Error(`${cust.displayName} is already on this route.`);
  }

  // Append at the end. MAX(stop_order)+1, or 1 if route is empty.
  const maxRow = db.prepare(
    `SELECT COALESCE(MAX(stop_order), 0) AS m FROM route_stops WHERE route_id = ?`,
  ).get(input.routeId) as { m: number };
  const stopOrder = maxRow.m + 1;
  const stopId = `rs-${uuidv4()}`;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO route_stops (id, route_id, customer_id, stop_order, created_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(stopId, input.routeId, input.customerId, stopOrder, input.workerId, deviceId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'ROUTE_STOP_ADDED',
      entityType: 'route_stops',
      entityId: stopId,
      afterValue: { routeId: input.routeId, customerId: input.customerId, stopOrder },
      deviceId,
    });
  });
  tx();
  return { stopId, stopOrder };
}

// Remove a stop and renumber the survivors so the sequence stays
// dense (1..N). Renumbering is a single SQL statement using a
// window expression simulated with a self-join — node-sqlite3-wasm
// supports SQLite 3.x ROW_NUMBER() via the standard window-function
// syntax.
export function removeStop(
  db: Database,
  input: { stopId: string; workerId: string },
  deviceId: string,
): void {
  const row = db.prepare(
    `SELECT id, route_id AS routeId, customer_id AS customerId, stop_order AS stopOrder
       FROM route_stops WHERE id = ?`,
  ).get(input.stopId) as
    | { id: string; routeId: string; customerId: string; stopOrder: number }
    | undefined;
  if (!row) throw new Error('Route stop not found.');

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM route_stops WHERE id = ?`).run(input.stopId);
    renumberStops(db, row.routeId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'ROUTE_STOP_REMOVED',
      entityType: 'route_stops',
      entityId: input.stopId,
      beforeValue: { routeId: row.routeId, customerId: row.customerId, stopOrder: row.stopOrder },
      deviceId,
    });
  });
  tx();
}

// Re-set stop_order for every row in a route so that they form a
// dense 1..N sequence in current order. Used internally after
// removeStop and explicitly by reorderStops.
function renumberStops(db: Database, routeId: string): void {
  const stops = db.prepare(
    `SELECT id FROM route_stops WHERE route_id = ? ORDER BY stop_order ASC, id ASC`,
  ).all(routeId) as Array<{ id: string }>;
  const update = db.prepare(`UPDATE route_stops SET stop_order = ? WHERE id = ?`);
  stops.forEach((s, i) => update.run(i + 1, s.id));
}

// Apply an explicit ordered list of stop ids. Validates that the
// provided ids are exactly the current set for the route (no
// additions or removals — those go through addStop/removeStop).
export function reorderStops(
  db: Database,
  input: { routeId: string; orderedStopIds: string[]; workerId: string },
  deviceId: string,
): void {
  const current = db.prepare(
    `SELECT id FROM route_stops WHERE route_id = ? ORDER BY stop_order ASC`,
  ).all(input.routeId) as Array<{ id: string }>;
  if (current.length !== input.orderedStopIds.length) {
    throw new Error(`Reorder ids count mismatch: route has ${current.length} stops, got ${input.orderedStopIds.length}.`);
  }
  const currentSet = new Set(current.map((s) => s.id));
  for (const id of input.orderedStopIds) {
    if (!currentSet.has(id)) {
      throw new Error('Reorder list contains an id that is not a stop on this route.');
    }
  }

  const tx = db.transaction(() => {
    const update = db.prepare(`UPDATE route_stops SET stop_order = ? WHERE id = ?`);
    input.orderedStopIds.forEach((id, i) => update.run(i + 1, id));

    logAudit(db, {
      workerId: input.workerId,
      action: 'ROUTE_STOPS_REORDERED',
      entityType: 'routes',
      entityId: input.routeId,
      afterValue: { orderedStopIds: input.orderedStopIds },
      deviceId,
    });
  });
  tx();
}
