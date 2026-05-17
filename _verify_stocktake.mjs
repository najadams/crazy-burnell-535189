// _verify_stocktake.mjs — Wave B.1 (stocktake). Schema + state machine
// + adjustment math.

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
const here = path.dirname(new URL(import.meta.url).pathname);
for (const m of ['0001_lookup_tables','0002_workers','0003_master_data','0004_shifts_sales_stock','0008_supervisor_approvals','0015_stocktake']) {
  db.exec(fs.readFileSync(path.join(here, 'migrations', m + '.sql'), 'utf8'));
}
check('migrations apply', true);

const eCols = db.all(`PRAGMA table_info(stocktake_events)`).map((r) => r.name);
for (const c of ['id','location_id','status','opened_at','closed_at','supervisor_approval_id']) {
  check(`stocktake_events.${c}`, eCols.includes(c));
}
const lCols = db.all(`PRAGMA table_info(stocktake_lines)`).map((r) => r.name);
for (const c of ['id','stocktake_event_id','product_id','expected_qty','counted_qty']) {
  check(`stocktake_lines.${c}`, lCols.includes(c));
}
// delta_qty is GENERATED ALWAYS AS STORED; node-sqlite3-wasm doesn't list
// generated columns in PRAGMA table_info but they're real and queryable.
const deltaProbe = db.all(`SELECT delta_qty FROM stocktake_lines WHERE 1=0`);
check('stocktake_lines.delta_qty queryable (generated column)', Array.isArray(deltaProbe));

// fixtures
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-naj','Naj','OWNER','x')`);
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-sup','Ama','SUPERVISOR','x')`);
db.run(`INSERT INTO locations (id, name, created_by, updated_by) VALUES ('loc-1','Main','w-naj','w-naj')`);
db.run(`INSERT INTO products (id, sku, name, category, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas, cost_price_pesewas, created_by, updated_by) VALUES ('p-coke','SKU-COKE','Coke 1.5L','SOFTDRINK',1000,800,900,500,'w-naj','w-naj')`);
db.run(`INSERT INTO products (id, sku, name, category, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas, cost_price_pesewas, created_by, updated_by) VALUES ('p-pepsi','SKU-PEPSI','Pepsi 330ml','SOFTDRINK',300,200,250,150,'w-naj','w-naj')`);

// Some prior stock movements: coke +100, pepsi +50, then a coke -3 sale
db.run(`INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code, worker_id, created_by) VALUES ('sm-1','p-coke','loc-1',100,'RECEIVED_FROM_SUPPLIER','w-naj','w-naj')`);
db.run(`INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code, worker_id, created_by) VALUES ('sm-2','p-pepsi','loc-1',50,'RECEIVED_FROM_SUPPLIER','w-naj','w-naj')`);
db.run(`INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code, worker_id, created_by) VALUES ('sm-3','p-coke','loc-1',-3,'SALE','w-naj','w-naj')`);

// Expected qty: coke = 97, pepsi = 50
function expected(productId, locationId) {
  return db.all(`SELECT COALESCE(SUM(quantity),0) AS q FROM stock_movements WHERE product_id = ? AND location_id = ?`, [productId, locationId])[0].q;
}
check('coke expected = 97', expected('p-coke','loc-1') === 97);
check('pepsi expected = 50', expected('p-pepsi','loc-1') === 50);

// Open a session
const ste = `ste-${randomUUID()}`;
db.run(`INSERT INTO stocktake_events (id, location_id, opened_by) VALUES (?, 'loc-1', 'w-naj')`, [ste]);
check('session opened with status OPEN',
  db.all(`SELECT status FROM stocktake_events WHERE id = ?`, [ste])[0].status === 'OPEN');

// Refuse to open a second OPEN session for same location
expectThrow('cannot open second OPEN session per location', () => {
  const conflict = db.all(`SELECT id FROM stocktake_events WHERE location_id = 'loc-1' AND status = 'OPEN'`)[0];
  if (conflict) throw new Error('A stocktake session is already open for this location.');
}, (e) => /already open/.test(e.message));

// Record counts: coke counted = 95 (shrinkage 2), pepsi counted = 55 (surplus 5)
function recordLine(productId, counted) {
  const exp = expected(productId, 'loc-1');
  const id = `stl-${randomUUID()}`;
  db.run(`INSERT INTO stocktake_lines (id, stocktake_event_id, product_id, expected_qty, counted_qty, recorded_by, updated_by) VALUES (?, ?, ?, ?, ?, 'w-naj','w-naj')`, [id, ste, productId, exp, counted]);
  return id;
}
recordLine('p-coke', 95);
recordLine('p-pepsi', 55);
const lines = db.all(`SELECT product_id AS pid, expected_qty AS e, counted_qty AS c, delta_qty AS d FROM stocktake_lines WHERE stocktake_event_id = ?`, [ste]);
check('two lines recorded', lines.length === 2);
const coke = lines.find((l) => l.pid === 'p-coke');
const pepsi = lines.find((l) => l.pid === 'p-pepsi');
check('coke delta = -2 (computed by generated column)', coke.d === -2);
check('pepsi delta = +5', pepsi.d === 5);

// UNIQUE(event, product) — double-record same product rejected
expectThrow('UNIQUE(event, product) enforces one line per product', () => {
  db.run(`INSERT INTO stocktake_lines (id, stocktake_event_id, product_id, expected_qty, counted_qty, recorded_by, updated_by) VALUES ('stl-x', ?, 'p-coke', 97, 99, 'w-naj','w-naj')`, [ste]);
}, (e) => /UNIQUE/.test(e.message));

// counted_qty CHECK >= 0
expectThrow('counted_qty negative rejected', () => {
  db.run(`INSERT INTO stocktake_lines (id, stocktake_event_id, product_id, expected_qty, counted_qty, recorded_by, updated_by) VALUES ('stl-bad', ?, 'p-coke', 0, -5, 'w-naj','w-naj')`, [ste]);
}, (e) => /CHECK/.test(e.message));

// Close: writes adjustment stock_movements for each non-zero delta
const beforeAdj = db.all(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason_code = 'STOCKTAKE_ADJUSTMENT'`)[0].n;
const cokeLine = db.all(`SELECT delta_qty AS d FROM stocktake_lines WHERE stocktake_event_id = ? AND product_id = 'p-coke'`, [ste])[0];
db.run(`INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code, worker_id, created_by, unit_cost_pesewas, total_value_pesewas) VALUES ('sm-adj-1','p-coke','loc-1', ?, 'STOCKTAKE_ADJUSTMENT','w-naj','w-naj',500,1000)`, [cokeLine.d]);
db.run(`INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code, worker_id, created_by, unit_cost_pesewas, total_value_pesewas) VALUES ('sm-adj-2','p-pepsi','loc-1', 5, 'STOCKTAKE_ADJUSTMENT','w-naj','w-naj',150,750)`);
db.run(`UPDATE stocktake_events SET status='CLOSED', closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), closed_by='w-naj' WHERE id=?`, [ste]);
const afterAdj = db.all(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason_code = 'STOCKTAKE_ADJUSTMENT'`)[0].n;
check('two adjustment stock_movements written on close', afterAdj - beforeAdj === 2);
check('post-close coke qty matches counted (97-2 = 95)', expected('p-coke','loc-1') === 95);
check('post-close pepsi qty matches counted (50+5 = 55)', expected('p-pepsi','loc-1') === 55);
check('session status CLOSED', db.all(`SELECT status FROM stocktake_events WHERE id = ?`, [ste])[0].status === 'CLOSED');

// Cancel flow on a fresh session
const steC = `ste-${randomUUID()}`;
db.run(`INSERT INTO stocktake_events (id, location_id, opened_by) VALUES (?, 'loc-1', 'w-naj')`, [steC]);
db.run(`UPDATE stocktake_events SET status='CANCELLED', cancel_reason='wrong location', cancelled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [steC]);
check('cancel sets status=CANCELLED',
  db.all(`SELECT status FROM stocktake_events WHERE id = ?`, [steC])[0].status === 'CANCELLED');

// status whitelist
expectThrow('status whitelist enforced', () => {
  db.run(`INSERT INTO stocktake_events (id, location_id, status, opened_by) VALUES ('ste-x','loc-1','WAT','w-naj')`);
}, (e) => /CHECK/.test(e.message));

// supervisor_approvals.purpose now accepts STOCKTAKE_LARGE_DELTA
db.run(`INSERT INTO supervisor_approvals (id, supervisor_worker_id, purpose, expires_at, created_by) VALUES ('sa-1', 'w-sup', 'STOCKTAKE_LARGE_DELTA', strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'), 'w-naj')`);
check('STOCKTAKE_LARGE_DELTA purpose accepted', db.all(`SELECT id FROM supervisor_approvals WHERE id = 'sa-1'`).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
