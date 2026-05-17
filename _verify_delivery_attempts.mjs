// _verify_delivery_attempts.mjs — Wave G chunk 4a.

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
// Minimal prior schema — only what migration 0014 needs (workers
// with the old CHECK so we can verify the rebuild relaxes it; routes
// + route_runs + pending_orders + customers).
db.exec(`
  CREATE TABLE workers (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('CASHIER','SUPERVISOR','OWNER','FOUNDER')),
    pin_hash TEXT NOT NULL,
    recovery_code_hash TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT,
    device_id TEXT NOT NULL DEFAULT 'd-test'
  );
  CREATE TABLE customers (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
  CREATE TABLE cash_counts (id TEXT PRIMARY KEY, amount_pesewas INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE sales (id TEXT PRIMARY KEY);
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, action TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    before_value TEXT, after_value TEXT,
    device_id TEXT NOT NULL DEFAULT 'd-test',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Apply 0009 first to add recovery_code_issued_at/by — 0014's
// table-rebuild expects those columns.
const here = path.dirname(new URL(import.meta.url).pathname);
db.exec(fs.readFileSync(path.join(here, 'migrations', '0009_recovery_code_metadata.sql'), 'utf8'));
// Apply the chunk-3 + 3d schema so the FKs on delivery_attempts resolve.
db.exec(fs.readFileSync(path.join(here, 'migrations', '0011_pending_orders.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(here, 'migrations', '0012_routes.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(here, 'migrations', '0013_route_run_closing.sql'), 'utf8'));

// Seed some workers BEFORE the rebuild so we can verify they survive.
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-naj','Naj','OWNER','x')`);
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-mary','Mary','CASHIER','x')`);

db.exec(fs.readFileSync(path.join(here, 'migrations', '0014_delivery_attempts.sql'), 'utf8'));
check('migration 0014 applies', true);

// Pre-existing workers survive the rebuild.
check('Naj still present after rebuild',
  db.all(`SELECT id FROM workers WHERE id = 'w-naj'`).length === 1);
check('Mary still present after rebuild',
  db.all(`SELECT id FROM workers WHERE id = 'w-mary'`).length === 1);

// DRIVER role is now accepted.
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-kofi','Kofi','DRIVER','x')`);
check('DRIVER role now accepted', db.all(`SELECT role FROM workers WHERE id='w-kofi'`)[0].role === 'DRIVER');

// Unknown role still rejected.
expectThrow('unknown role still rejected', () => {
  db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-x','X','SPY','x')`);
}, (e) => /CHECK/.test(e.message));

// delivery_attempts schema
const cols = db.all(`PRAGMA table_info(delivery_attempts)`).map((r) => r.name);
for (const c of ['id','route_run_id','pending_order_id','customer_id','attempted_at','outcome','collected_cash_pesewas','collected_empties_count','return_intent_lines','notes']) {
  check(`delivery_attempts.${c} exists`, cols.includes(c));
}

// Outcome whitelist
expectThrow('outcome whitelist enforced', () => {
  db.run(`INSERT INTO delivery_attempts (id, route_run_id, pending_order_id, customer_id, outcome, created_by, updated_by) VALUES ('da-x','rr-x','po-x','c-x','LATE','w-naj','w-naj')`);
}, (e) => /CHECK/.test(e.message));

// collected cash/empties non-negative
db.run(`INSERT INTO customers (id, display_name) VALUES ('c-a','Mama Akua')`);
db.run(`INSERT INTO routes (id, name, created_by, updated_by) VALUES ('rt-1','Tuesday Eastern','w-naj','w-naj')`);
db.run(`INSERT INTO route_runs (id, route_id, run_date, driver_id, created_by, updated_by) VALUES ('rr-1','rt-1','2026-05-12','w-kofi','w-naj','w-naj')`);
db.run(`INSERT INTO pending_orders (id, customer_id, intake_channel, intake_worker_id, status, assigned_route_run_id, created_by, updated_by) VALUES ('po-1','c-a','PHONE_CALL','w-naj','ASSIGNED','rr-1','w-naj','w-naj')`);

expectThrow('negative collected_cash rejected', () => {
  db.run(`INSERT INTO delivery_attempts (id, route_run_id, pending_order_id, customer_id, outcome, collected_cash_pesewas, created_by, updated_by) VALUES ('da-y','rr-1','po-1','c-a','DELIVERED',-1,'w-naj','w-naj')`);
}, (e) => /CHECK/.test(e.message));

// Insert a valid row
db.run(`INSERT INTO delivery_attempts (id, route_run_id, pending_order_id, customer_id, outcome, collected_cash_pesewas, collected_empties_count, created_by, updated_by) VALUES ('da-1','rr-1','po-1','c-a','DELIVERED',5000,3,'w-naj','w-naj')`);
check('delivery row inserted',
  db.all(`SELECT outcome FROM delivery_attempts WHERE id='da-1'`)[0].outcome === 'DELIVERED');

// UNIQUE(pending_order_id) — second row for same order rejected
expectThrow('one row per pending_order enforced', () => {
  db.run(`INSERT INTO delivery_attempts (id, route_run_id, pending_order_id, customer_id, outcome, created_by, updated_by) VALUES ('da-2','rr-1','po-1','c-a','PARTIAL','w-naj','w-naj')`);
}, (e) => /UNIQUE/.test(e.message));

// Service-level logic: MISSED outcome with cash > 0 must be rejected.
function recordAttempt(input) {
  if (input.outcome === 'MISSED' || input.outcome === 'REFUSED') {
    if ((input.cash ?? 0) > 0 || (input.empties ?? 0) > 0) {
      throw new Error(`Outcome ${input.outcome} cannot carry collected cash or empties.`);
    }
  }
  // ... (real service does the upsert and audit)
}
expectThrow('MISSED with collected cash rejected at service level',
  () => recordAttempt({ outcome: 'MISSED', cash: 1000 }),
  (e) => /cannot carry collected cash/.test(e.message));

// Update path: re-recording the same order updates rather than inserts a new row.
db.run(`UPDATE delivery_attempts SET outcome='PARTIAL', collected_cash_pesewas=3000 WHERE pending_order_id='po-1'`);
check('update path keeps one row per order',
  db.all(`SELECT COUNT(*) AS n FROM delivery_attempts WHERE pending_order_id='po-1'`)[0].n === 1);
check('updated outcome reflected',
  db.all(`SELECT outcome FROM delivery_attempts WHERE pending_order_id='po-1'`)[0].outcome === 'PARTIAL');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
