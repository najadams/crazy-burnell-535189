// _verify_routes.mjs — Wave G chunk 3a/3b. Schema + routes service.

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
  CREATE TABLE workers   (id TEXT PRIMARY KEY, full_name TEXT, role TEXT);
  CREATE TABLE customers (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', blocked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE cash_counts (id TEXT PRIMARY KEY, amount_pesewas INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, action TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    before_value TEXT, after_value TEXT,
    device_id TEXT NOT NULL DEFAULT 'd-test',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const here = path.dirname(new URL(import.meta.url).pathname);
db.exec(fs.readFileSync(path.join(here, 'migrations', '0012_routes.sql'), 'utf8'));
check('migration 0012 applies', true);

const routeCols = db.all(`PRAGMA table_info(routes)`).map((r) => r.name);
for (const c of ['id','name','weekday_pattern','active','notes']) {
  check(`routes.${c} exists`, routeCols.includes(c));
}
const stopCols = db.all(`PRAGMA table_info(route_stops)`).map((r) => r.name);
for (const c of ['id','route_id','customer_id','stop_order']) {
  check(`route_stops.${c} exists`, stopCols.includes(c));
}
const runCols = db.all(`PRAGMA table_info(route_runs)`).map((r) => r.name);
for (const c of ['id','route_id','run_date','driver_id','status','closed_at','reconciled_at','opening_cash_count_id','closing_blind_count_id']) {
  check(`route_runs.${c} exists`, runCols.includes(c));
}

// fixtures
db.run(`INSERT INTO workers (id, full_name, role) VALUES ('w-naj','Naj','OWNER')`);
db.run(`INSERT INTO customers (id, display_name) VALUES ('c-a','Mama Akua')`);
db.run(`INSERT INTO customers (id, display_name) VALUES ('c-b','Bro Kojo')`);
db.run(`INSERT INTO customers (id, display_name) VALUES ('c-c','Auntie Effe')`);
db.run(`INSERT INTO customers (id, display_name, blocked) VALUES ('c-blocked','Bro Bad',1)`);

// Service logic, re-implemented
const ALLOWED_WEEKDAYS = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
function validatePattern(p) {
  if (p === '') return;
  for (const part of p.split(',').map((s) => s.trim().toUpperCase())) {
    if (!ALLOWED_WEEKDAYS.includes(part)) throw new Error(`Invalid weekday code "${part}".`);
  }
}
function createRoute({ name, pattern = '', workerId = 'w-naj' }) {
  name = name.trim();
  if (name.length < 2) throw new Error('Route name must be at least 2 characters.');
  pattern = pattern.trim().toUpperCase();
  validatePattern(pattern);
  const id = `rt-${randomUUID()}`;
  db.run(`INSERT INTO routes (id, name, weekday_pattern, created_by, updated_by) VALUES (?, ?, ?, ?, ?)`, [id, name, pattern, workerId, workerId]);
  return id;
}
function listStops(routeId) {
  return db.all(`SELECT id, stop_order AS stopOrder, customer_id AS customerId FROM route_stops WHERE route_id = ? ORDER BY stop_order ASC`, [routeId]);
}
function addStop(routeId, customerId, workerId = 'w-naj') {
  const route = db.all(`SELECT id, active FROM routes WHERE id = ?`, [routeId])[0];
  if (!route) throw new Error('Route not found.');
  if (!route.active) throw new Error('Cannot add stops to an archived route.');
  const cust = db.all(`SELECT id, blocked, display_name AS displayName FROM customers WHERE id = ?`, [customerId])[0];
  if (!cust) throw new Error('Customer not found.');
  if (cust.blocked) throw new Error(`${cust.displayName} is blocked — cannot be added to a route.`);
  const exists = db.all(`SELECT id FROM route_stops WHERE route_id = ? AND customer_id = ?`, [routeId, customerId])[0];
  if (exists) throw new Error(`${cust.displayName} is already on this route.`);
  const m = db.all(`SELECT COALESCE(MAX(stop_order),0) AS m FROM route_stops WHERE route_id = ?`, [routeId])[0].m;
  const order = m + 1;
  const id = `rs-${randomUUID()}`;
  db.run(`INSERT INTO route_stops (id, route_id, customer_id, stop_order, created_by) VALUES (?, ?, ?, ?, ?)`, [id, routeId, customerId, order, workerId]);
  return { stopId: id, stopOrder: order };
}
function renumber(routeId) {
  const stops = db.all(`SELECT id FROM route_stops WHERE route_id = ? ORDER BY stop_order ASC, id ASC`, [routeId]);
  stops.forEach((s, i) => db.run(`UPDATE route_stops SET stop_order = ? WHERE id = ?`, [i + 1, s.id]));
}
function removeStop(stopId) {
  const row = db.all(`SELECT route_id AS routeId FROM route_stops WHERE id = ?`, [stopId])[0];
  if (!row) throw new Error('Route stop not found.');
  db.run(`DELETE FROM route_stops WHERE id = ?`, [stopId]);
  renumber(row.routeId);
}
function archiveRoute(routeId) {
  const row = db.all(`SELECT active FROM routes WHERE id = ?`, [routeId])[0];
  if (!row) throw new Error('Route not found.');
  if (!row.active) throw new Error('Route is already archived.');
  db.run(`UPDATE routes SET active = 0 WHERE id = ?`, [routeId]);
}

// route create + validate
const r1 = createRoute({ name: 'Tuesday Eastern', pattern: 'TUE,FRI' });
check('route created with weekday pattern', !!r1);
expectThrow('short route name rejected', () => createRoute({ name: 'A' }), (e) => /at least 2 characters/.test(e.message));
expectThrow('bad weekday code rejected', () => createRoute({ name: 'Bad', pattern: 'NOON' }), (e) => /Invalid weekday/.test(e.message));

// Empty pattern allowed (ad-hoc routes)
const rAdhoc = createRoute({ name: 'Ad-hoc' });
check('empty weekday pattern allowed', !!rAdhoc);

// add stops
addStop(r1, 'c-a');
addStop(r1, 'c-b');
addStop(r1, 'c-c');
const stops1 = listStops(r1);
check('three stops added', stops1.length === 3);
check('stop_order is dense 1..3', stops1[0].stopOrder === 1 && stops1[1].stopOrder === 2 && stops1[2].stopOrder === 3);

// duplicate customer rejected
expectThrow('duplicate customer on same route rejected',
  () => addStop(r1, 'c-a'),
  (e) => /already on this route/.test(e.message));

// blocked customer rejected
expectThrow('blocked customer rejected',
  () => addStop(r1, 'c-blocked'),
  (e) => /blocked/.test(e.message));

// remove + renumber
removeStop(stops1[1].id);
const stops2 = listStops(r1);
check('remove leaves 2 stops', stops2.length === 2);
check('renumbering keeps sequence dense (1..2)', stops2[0].stopOrder === 1 && stops2[1].stopOrder === 2);

// reorder
const orderedIds = [stops2[1].id, stops2[0].id];  // swap them
db.exec('BEGIN');
const update = db.prepare(`UPDATE route_stops SET stop_order = ? WHERE id = ?`);
orderedIds.forEach((id, i) => update.run([i + 1, id]));
db.exec('COMMIT');
const stops3 = listStops(r1);
check('reorder swapped stop order', stops3[0].id === orderedIds[0] && stops3[1].id === orderedIds[1]);

// archive
archiveRoute(r1);
expectThrow('cannot add stops to archived route',
  () => addStop(r1, 'c-c'),
  (e) => /archived/.test(e.message));
expectThrow('cannot archive twice',
  () => archiveRoute(r1),
  (e) => /already archived/.test(e.message));

// route_runs: schema-level checks
expectThrow('status whitelist enforced on route_runs', () => {
  db.run(`INSERT INTO route_runs (id, route_id, run_date, driver_id, status, created_by, updated_by) VALUES ('rr-x','${r1}','2026-05-12','w-naj','SHIPPING','w-naj','w-naj')`);
}, (e) => /CHECK/.test(e.message));

expectThrow('run_date length must be 10 (YYYY-MM-DD)', () => {
  db.run(`INSERT INTO route_runs (id, route_id, run_date, driver_id, created_by, updated_by) VALUES ('rr-x','${r1}','2026-5-12','w-naj','w-naj','w-naj')`);
}, (e) => /CHECK/.test(e.message));

// UNIQUE(route_id, run_date)
db.run(`INSERT INTO route_runs (id, route_id, run_date, driver_id, created_by, updated_by) VALUES ('rr-1','${r1}','2026-05-12','w-naj','w-naj','w-naj')`);
expectThrow('one run per route per date enforced', () => {
  db.run(`INSERT INTO route_runs (id, route_id, run_date, driver_id, created_by, updated_by) VALUES ('rr-2','${r1}','2026-05-12','w-naj','w-naj','w-naj')`);
}, (e) => /UNIQUE/.test(e.message));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
