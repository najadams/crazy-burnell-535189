// _verify_route_runs.mjs — Wave G chunk 3d. Route-run lifecycle.

import pkg from 'node-sqlite3-wasm';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const { Database } = pkg;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}
function expectThrow(name, fn, matcher) {
  try { fn(); check(name, false, 'expected throw'); }
  catch (e) {
    const ok = matcher ? matcher(e) : true;
    check(name, ok, ok ? '' : `wrong error: ${e.message}`);
  }
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE workers   (id TEXT PRIMARY KEY, full_name TEXT, role TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE customers (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', blocked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE cash_counts (id TEXT PRIMARY KEY, amount_pesewas INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE sales (id TEXT PRIMARY KEY, shift_id TEXT, worker_id TEXT, location_id TEXT, channel TEXT, subtotal_pesewas INTEGER, total_pesewas INTEGER, created_by TEXT);
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, action TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    before_value TEXT, after_value TEXT,
    device_id TEXT NOT NULL DEFAULT 'd-test',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const here = path.dirname(new URL(import.meta.url).pathname);
db.exec(fs.readFileSync(path.join(here, 'migrations', '0011_pending_orders.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(here, 'migrations', '0012_routes.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(here, 'migrations', '0013_route_run_closing.sql'), 'utf8'));
check('migrations 0011/0012/0013 apply', true);

const cols = db.all(`PRAGMA table_info(route_runs)`).map((r) => r.name);
for (const c of ['closing_cash_pesewas','closed_by','reconciled_by','reconciliation_notes','reopened_at','reopened_by','reopen_reason']) {
  check(`route_runs.${c} added by 0013`, cols.includes(c));
}

// Fixtures
db.run(`INSERT INTO workers (id, full_name, role) VALUES ('w-naj','Naj','OWNER')`);
db.run(`INSERT INTO workers (id, full_name, role) VALUES ('w-driver','Kofi','CASHIER')`);
db.run(`INSERT INTO workers (id, full_name, role, active) VALUES ('w-inactive','Old','CASHIER',0)`);
db.run(`INSERT INTO customers (id, display_name) VALUES ('c-a','Mama Akua')`);
db.run(`INSERT INTO customers (id, display_name) VALUES ('c-b','Bro Kojo')`);
db.run(`INSERT INTO routes (id, name, weekday_pattern, created_by, updated_by) VALUES ('rt-tue','Tuesday Eastern','TUE','w-naj','w-naj')`);
db.run(`INSERT INTO routes (id, name, weekday_pattern, active, created_by, updated_by) VALUES ('rt-arch','Old route','MON',0,'w-naj','w-naj')`);

// service logic re-implemented
function openRun(routeId, runDate, driverId, workerId = 'w-naj') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) throw new Error('Run date must be in YYYY-MM-DD format.');
  const route = db.all(`SELECT id, name, active FROM routes WHERE id = ?`, [routeId])[0];
  if (!route) throw new Error('Route not found.');
  if (!route.active) throw new Error(`Route "${route.name}" is archived — reactivate it first.`);
  const driver = db.all(`SELECT id FROM workers WHERE id = ? AND active = 1`, [driverId])[0];
  if (!driver) throw new Error('Driver not found or inactive.');
  const existing = db.all(`SELECT id FROM route_runs WHERE route_id = ? AND run_date = ?`, [routeId, runDate])[0];
  if (existing) throw new Error(`A run for ${route.name} on ${runDate} already exists.`);
  const id = `rrun-${randomUUID()}`;
  db.run(`INSERT INTO route_runs (id, route_id, run_date, driver_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)`, [id, routeId, runDate, driverId, workerId, workerId]);
  return id;
}
function createOrder(customerId, workerId = 'w-naj') {
  const id = `po-${randomUUID()}`;
  db.run(`INSERT INTO pending_orders (id, customer_id, intake_channel, intake_worker_id, created_by, updated_by) VALUES (?, ?, 'PHONE_CALL', ?, ?, ?)`, [id, customerId, workerId, workerId, workerId]);
  return id;
}
function assignOrder(orderId, runId, workerId = 'w-naj') {
  const order = db.all(`SELECT status, assigned_route_run_id AS arr FROM pending_orders WHERE id = ?`, [orderId])[0];
  if (!order) throw new Error('Pending order not found.');
  if (order.status !== 'CREATED') throw new Error(`Only CREATED orders can be assigned to a run (current: ${order.status}).`);
  if (order.arr) throw new Error('Order is already assigned to a run.');
  const run = db.all(`SELECT status FROM route_runs WHERE id = ?`, [runId])[0];
  if (!run) throw new Error('Route run not found.');
  if (run.status !== 'OPEN') throw new Error(`Cannot assign to a run with status ${run.status}.`);
  db.run(`UPDATE pending_orders SET assigned_route_run_id = ?, status = 'ASSIGNED', updated_by = ? WHERE id = ?`, [runId, workerId, orderId]);
}
function unassignOrder(orderId, workerId = 'w-naj') {
  const order = db.all(`SELECT status, assigned_route_run_id AS arr FROM pending_orders WHERE id = ?`, [orderId])[0];
  if (!order) throw new Error('Pending order not found.');
  if (order.status !== 'ASSIGNED') throw new Error(`Only ASSIGNED orders can be unassigned (current: ${order.status}).`);
  if (order.arr) {
    const run = db.all(`SELECT status FROM route_runs WHERE id = ?`, [order.arr])[0];
    if (run && run.status !== 'OPEN') throw new Error('Cannot unassign from a run that is no longer OPEN.');
  }
  db.run(`UPDATE pending_orders SET assigned_route_run_id = NULL, status = 'CREATED', updated_by = ? WHERE id = ?`, [workerId, orderId]);
}
function closeRun(runId, cash, workerId = 'w-naj') {
  if (!Number.isInteger(cash) || cash < 0) throw new Error('Closing cash must be a non-negative whole number of pesewas.');
  const run = db.all(`SELECT status FROM route_runs WHERE id = ?`, [runId])[0];
  if (!run) throw new Error('Route run not found.');
  if (run.status !== 'OPEN' && run.status !== 'RETURNING') throw new Error(`Cannot close a run with status ${run.status}.`);
  db.run(`UPDATE route_runs SET status='CLOSED', closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), closed_by=?, closing_cash_pesewas=?, updated_by=? WHERE id=?`, [workerId, cash, workerId, runId]);
}
function reconcile(runId, workerId = 'w-naj') {
  const run = db.all(`SELECT status FROM route_runs WHERE id = ?`, [runId])[0];
  if (!run) throw new Error('Route run not found.');
  if (run.status !== 'CLOSED') throw new Error(`Cannot reconcile a run with status ${run.status}.`);
  const pending = db.all(`SELECT COUNT(*) AS n FROM pending_orders WHERE assigned_route_run_id = ? AND status NOT IN ('CONVERTED','CANCELLED')`, [runId])[0];
  if (pending.n > 0) throw new Error(`${pending.n} assigned order(s) are still in flight (not converted or cancelled). Reconcile blocked.`);
  db.run(`UPDATE route_runs SET status='RECONCILED', reconciled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), reconciled_by=?, updated_by=? WHERE id=?`, [workerId, workerId, runId]);
}
function reopenRun(runId, reason, workerId = 'w-naj') {
  if (!reason || reason.trim().length < 3) throw new Error('A reopen reason is required.');
  const run = db.all(`SELECT status, reopened_at AS reopenedAt FROM route_runs WHERE id = ?`, [runId])[0];
  if (!run) throw new Error('Route run not found.');
  if (run.status === 'RECONCILED') throw new Error('Cannot reopen a reconciled run.');
  if (run.status !== 'CLOSED') throw new Error(`Cannot reopen a run with status ${run.status}.`);
  if (run.reopenedAt) throw new Error('This run has already been reopened once and cannot be reopened again.');
  db.run(`UPDATE route_runs SET status='OPEN', reopened_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), reopened_by=?, reopen_reason=?, updated_by=? WHERE id=?`, [workerId, reason.trim(), workerId, runId]);
}

// happy path
const run1 = openRun('rt-tue', '2026-05-12', 'w-driver');
check('open run produces a row', !!run1);
check('initial status = OPEN', db.all(`SELECT status FROM route_runs WHERE id = ?`, [run1])[0].status === 'OPEN');

expectThrow('duplicate run per route per date rejected',
  () => openRun('rt-tue', '2026-05-12', 'w-driver'),
  (e) => /already exists/.test(e.message));

expectThrow('cannot open run on archived route',
  () => openRun('rt-arch', '2026-05-12', 'w-driver'),
  (e) => /archived/.test(e.message));

expectThrow('cannot open run with inactive driver',
  () => openRun('rt-tue', '2026-05-13', 'w-inactive'),
  (e) => /Driver not found or inactive/.test(e.message));

expectThrow('bad date format rejected',
  () => openRun('rt-tue', '2026/05/13', 'w-driver'),
  (e) => /YYYY-MM-DD/.test(e.message));

// assign orders
const o1 = createOrder('c-a');
const o2 = createOrder('c-b');
assignOrder(o1, run1);
assignOrder(o2, run1);
check('two orders assigned',
  db.all(`SELECT COUNT(*) AS n FROM pending_orders WHERE assigned_route_run_id = ?`, [run1])[0].n === 2);
check('assigned orders have status ASSIGNED',
  db.all(`SELECT status FROM pending_orders WHERE id = ?`, [o1])[0].status === 'ASSIGNED');

// can't assign already-assigned
expectThrow('cannot assign already-assigned order (rejected by status check first)',
  () => assignOrder(o1, run1),
  (e) => /Only CREATED orders/.test(e.message) || /already assigned/.test(e.message));

// unassign one
unassignOrder(o1);
check('after unassign, order is back to CREATED',
  db.all(`SELECT status FROM pending_orders WHERE id = ?`, [o1])[0].status === 'CREATED');
check('after unassign, assigned_route_run_id is NULL',
  db.all(`SELECT assigned_route_run_id AS arr FROM pending_orders WHERE id = ?`, [o1])[0].arr === null);

// re-assign
assignOrder(o1, run1);

// close: reconcile blocked while orders in flight
closeRun(run1, 20000);
check('close sets status=CLOSED', db.all(`SELECT status FROM route_runs WHERE id = ?`, [run1])[0].status === 'CLOSED');
check('closing_cash recorded',
  db.all(`SELECT closing_cash_pesewas AS c FROM route_runs WHERE id = ?`, [run1])[0].c === 20000);

expectThrow('cannot reconcile while orders are in flight (ASSIGNED, not CONVERTED/CANCELLED)',
  () => reconcile(run1),
  (e) => /still in flight/.test(e.message));

// can't unassign from a CLOSED run
expectThrow('cannot unassign from CLOSED run',
  () => unassignOrder(o1),
  (e) => /no longer OPEN/.test(e.message));

// simulate conversion + cancellation
db.run(`INSERT INTO sales (id, shift_id, worker_id, location_id, channel, subtotal_pesewas, total_pesewas, created_by) VALUES ('sale-1','shift-1','w-naj','loc-1','ROUTE',1000,1000,'w-naj')`);
db.run(`UPDATE pending_orders SET status='CONVERTED', conversion_sale_id='sale-1', updated_by='w-naj' WHERE id = ?`, [o1]);
db.run(`UPDATE pending_orders SET status='CANCELLED', cancel_reason='customer pulled', updated_by='w-naj' WHERE id = ?`, [o2]);

reconcile(run1);
check('reconcile succeeds when all assigned orders terminal',
  db.all(`SELECT status FROM route_runs WHERE id = ?`, [run1])[0].status === 'RECONCILED');

expectThrow('cannot reopen a reconciled run',
  () => reopenRun(run1, 'oops'),
  (e) => /reconciled/.test(e.message));

// reopen test: open another run, close, reopen
const run2 = openRun('rt-tue', '2026-05-13', 'w-driver');
closeRun(run2, 5000);
reopenRun(run2, 'Driver brought back extra cash needs investigation');
check('reopened run is back to OPEN',
  db.all(`SELECT status FROM route_runs WHERE id = ?`, [run2])[0].status === 'OPEN');
check('reopened_at recorded',
  !!db.all(`SELECT reopened_at AS r FROM route_runs WHERE id = ?`, [run2])[0].r);

closeRun(run2, 5500);  // closed second time after the reopen
expectThrow('cannot reopen twice',
  () => reopenRun(run2, 'another shot'),
  (e) => /already been reopened/.test(e.message));

// closing cash validation
expectThrow('negative closing cash rejected',
  () => closeRun(openRun('rt-tue', '2026-05-14', 'w-driver'), -100),
  (e) => /non-negative/.test(e.message));

// schema check: closing_cash_pesewas CHECK
expectThrow('negative closing_cash_pesewas blocked at schema level', () => {
  db.run(`UPDATE route_runs SET closing_cash_pesewas = -1 WHERE id = ?`, [run2]);
}, (e) => /CHECK/.test(e.message));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
