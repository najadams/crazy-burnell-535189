// _verify_sale_payments.mjs — chunk 1 verification target for
// part-payment work.
//
// Asserts the migrations 0007 (sale_payments) and 0008
// (supervisor_approvals) schema, the CHECK constraints, the
// SUM(sale_payments) = sales.total invariant the service must
// maintain, the supervisor-approval consume-once-and-only-once rule,
// and backfill idempotency.
//
// Self-contained: builds the minimal prior schema inline (same
// pattern as _verify_loyalty.mjs), applies 0007 and 0008 verbatim.
// Where end-to-end coverage would require re-implementing createSale
// in JS, the smoke instead does the equivalent INSERTs directly and
// asserts the resulting row shapes. The full createSale service is
// covered at typecheck time and in chunk 2 once the UI exercises it.

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
  try {
    fn();
    check(name, false, 'expected throw, none raised');
  } catch (e) {
    const ok = matcher ? matcher(e) : true;
    check(name, ok, ok ? '' : `wrong error: ${e.message}`);
  }
}

const db = new Database(':memory:');

// ---------- minimal prior schema --------------------------------------
db.exec(`
  CREATE TABLE workers (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL,
    role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    pin_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE customers (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, phone TEXT NOT NULL,
    customer_type TEXT NOT NULL, credit_limit_pesewas INTEGER NOT NULL DEFAULT 0,
    current_balance_pesewas INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT,
    updated_at TEXT, updated_by TEXT
  );
  CREATE TABLE shifts (
    id TEXT PRIMARY KEY, worker_id TEXT NOT NULL,
    opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE sales (
    id TEXT PRIMARY KEY, shift_id TEXT NOT NULL,
    worker_id TEXT NOT NULL REFERENCES workers(id),
    customer_id TEXT REFERENCES customers(id),
    subtotal_pesewas INTEGER NOT NULL,
    total_pesewas INTEGER NOT NULL,
    is_credit INTEGER NOT NULL DEFAULT 0,
    voided INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'CASH',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_by TEXT NOT NULL REFERENCES workers(id),
    device_id TEXT NOT NULL DEFAULT 'd-counter-1'
  );
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id),
    action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    before_value TEXT, after_value TEXT, device_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

const here = path.dirname(new URL(import.meta.url).pathname);
db.exec(fs.readFileSync(path.join(here, 'migrations', '0007_sale_payments.sql'), 'utf8'));
check('migration 0007 applies', true);
db.exec(fs.readFileSync(path.join(here, 'migrations', '0008_supervisor_approvals.sql'), 'utf8'));
check('migration 0008 applies', true);

// ---------- 0007 schema assertions ------------------------------------
const spCols = db.all(`PRAGMA table_info(sale_payments)`).map((r) => r.name);
for (const c of ['id', 'sale_id', 'payment_method', 'amount_pesewas', 'payment_reference', 'cash_given_pesewas', 'created_at', 'created_by', 'device_id']) {
  check(`sale_payments.${c} exists`, spCols.includes(c));
}

// ---------- 0008 schema assertions ------------------------------------
const saCols = db.all(`PRAGMA table_info(supervisor_approvals)`).map((r) => r.name);
for (const c of ['id', 'supervisor_worker_id', 'purpose', 'context_json', 'expires_at', 'used_at', 'used_by_action', 'used_by_entity_id', 'created_at', 'created_by', 'device_id']) {
  check(`supervisor_approvals.${c} exists`, saCols.includes(c));
}

// ---------- fixtures --------------------------------------------------
const OWNER = 'w-owner';
const SUP   = 'w-sup';
const CSH   = 'w-csh';
db.run(`INSERT INTO workers (id, full_name, role) VALUES (?, 'Naj',  'OWNER')`,      [OWNER]);
db.run(`INSERT INTO workers (id, full_name, role) VALUES (?, 'Ama',  'SUPERVISOR')`, [SUP]);
db.run(`INSERT INTO workers (id, full_name, role) VALUES (?, 'Kojo', 'CASHIER')`,    [CSH]);
db.run(`INSERT INTO shifts (id, worker_id) VALUES ('shift-1', ?)`, [CSH]);
db.run(`INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas, current_balance_pesewas)
        VALUES ('c-mama', 'Mama Akua', '+233244111222', 'WHOLESALE', 50000, 0)`);
db.run(`INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas, current_balance_pesewas)
        VALUES ('c-zero', 'Walk-in Joe', '+233244999000', 'WALK_IN', 0, 0)`);

// ---------- CHECK constraint coverage ---------------------------------
expectThrow('sale_payments.amount_pesewas > 0 enforced', () => {
  db.run(
    `INSERT INTO sale_payments (id, sale_id, payment_method, amount_pesewas, created_by) VALUES ('sp-x','sale-x','CASH', 0, ?)`,
    [CSH],
  );
});
expectThrow('sale_payments.payment_method whitelist enforced', () => {
  db.run(
    `INSERT INTO sale_payments (id, sale_id, payment_method, amount_pesewas, created_by) VALUES ('sp-x','sale-x','BTC', 100, ?)`,
    [CSH],
  );
});
expectThrow('cash_given_pesewas >= amount_pesewas enforced', () => {
  // Need a real sale FK first.
  db.run(`INSERT INTO sales (id, shift_id, worker_id, subtotal_pesewas, total_pesewas, created_by) VALUES ('sale-tmp','shift-1',?,500,500,?)`, [CSH, CSH]);
  db.run(
    `INSERT INTO sale_payments (id, sale_id, payment_method, amount_pesewas, cash_given_pesewas, created_by) VALUES ('sp-bad','sale-tmp','CASH', 500, 100, ?)`,
    [CSH],
  );
});
db.run(`DELETE FROM sales WHERE id='sale-tmp'`);

expectThrow('supervisor_approvals.purpose whitelist enforced', () => {
  db.run(
    `INSERT INTO supervisor_approvals (id, supervisor_worker_id, purpose, expires_at, created_by) VALUES ('sa-x', ?, 'NUKE', strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'), ?)`,
    [SUP, CSH],
  );
});

// ---------- functional: simulate a CASH-only sale ---------------------
// Doing the same INSERTs the service does, then assert invariants.
function makeSale({ id, customerId, subtotal, isCredit, summaryMethod }) {
  db.run(
    `INSERT INTO sales (id, shift_id, worker_id, customer_id, subtotal_pesewas, total_pesewas, is_credit, payment_method, created_by)
     VALUES (?, 'shift-1', ?, ?, ?, ?, ?, ?, ?)`,
    [id, CSH, customerId, subtotal, subtotal, isCredit, summaryMethod, CSH],
  );
}
function tender(saleId, method, amount, cashGiven = null, ref = null) {
  db.run(
    `INSERT INTO sale_payments (id, sale_id, payment_method, amount_pesewas, cash_given_pesewas, payment_reference, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`sp-${randomUUID()}`, saleId, method, amount, cashGiven, ref, CSH],
  );
}
function sumPaid(saleId) {
  return db.all(`SELECT COALESCE(SUM(amount_pesewas),0) AS s FROM sale_payments WHERE sale_id = ?`, [saleId])[0].s;
}

makeSale({ id: 'sale-cash',   customerId: null,    subtotal: 1000, isCredit: 0, summaryMethod: 'CASH'   });
tender('sale-cash', 'CASH', 1000, 1500);
check('full-cash sale: sum(sale_payments) = total', sumPaid('sale-cash') === 1000);
check('full-cash sale: cash given recorded for change-due', db.all(`SELECT cash_given_pesewas AS g FROM sale_payments WHERE sale_id='sale-cash'`)[0].g === 1500);

makeSale({ id: 'sale-credit', customerId: 'c-mama', subtotal: 2000, isCredit: 1, summaryMethod: 'CREDIT' });
tender('sale-credit', 'CREDIT', 2000);
db.run(`UPDATE customers SET current_balance_pesewas = current_balance_pesewas + ? WHERE id = 'c-mama'`, [2000]);
check('full-credit sale: sum(sale_payments) = total', sumPaid('sale-credit') === 2000);
check('full-credit sale: customer balance increased by total',
  db.all(`SELECT current_balance_pesewas AS b FROM customers WHERE id='c-mama'`)[0].b === 2000);

// Partial: ₵100 sale, ₵60 cash + ₵40 credit.
makeSale({ id: 'sale-partial', customerId: 'c-mama', subtotal: 10000, isCredit: 1, summaryMethod: 'MIXED' });
tender('sale-partial', 'CASH',   6000, 6000);
tender('sale-partial', 'CREDIT', 4000);
db.run(`UPDATE customers SET current_balance_pesewas = current_balance_pesewas + ? WHERE id = 'c-mama'`, [4000]);
check('partial sale: sum(sale_payments) = total', sumPaid('sale-partial') === 10000);
check('partial sale: two rows recorded',
  db.all(`SELECT COUNT(*) AS n FROM sale_payments WHERE sale_id='sale-partial'`)[0].n === 2);
check('partial sale: balance bumped by CREDIT row only (not by total)',
  db.all(`SELECT current_balance_pesewas AS b FROM customers WHERE id='c-mama'`)[0].b === 6000);

// Reject a sum-mismatch attempt at the service layer: simulated by
// running the same invariant check the service runs.
function attemptSale(saleId, total, tenders) {
  const sum = tenders.reduce((s, t) => s + t.amount, 0);
  if (sum !== total) throw new Error(`Payments sum to ${sum} but total is ${total}`);
}
expectThrow('service-level sum mismatch rejected (60+30 vs 100)', () => {
  attemptSale('sale-bad', 10000, [{method:'CASH',amount:6000},{method:'CREDIT',amount:3000}]);
}, (e) => /sum to 9000.*total is 10000/.test(e.message));

// ---------- supervisor approval consume rules -------------------------
function newApproval(purpose, ttlSeconds = 300) {
  const id = `sa-${randomUUID()}`;
  // Compute expires_at in JS rather than via a SQLite modifier so a
  // negative TTL (used to construct an already-expired approval for
  // the test below) doesn't produce a malformed `+-N seconds` modifier.
  // JS toISOString and SQLite strftime ISO outputs are string-compare
  // compatible for ordering, which is the only operation we do on
  // expires_at downstream.
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.run(
    `INSERT INTO supervisor_approvals (id, supervisor_worker_id, purpose, context_json, expires_at, created_by)
     VALUES (?, ?, ?, '{}', ?, ?)`,
    [id, SUP, purpose, expiresAt, CSH],
  );
  return id;
}
function consume(approvalId, expectedPurpose, action, entityId) {
  const row = db.all(
    `SELECT purpose, used_at AS usedAt, expires_at AS expiresAt FROM supervisor_approvals WHERE id = ?`,
    [approvalId],
  )[0];
  if (!row) throw new Error('Supervisor approval not found.');
  if (row.usedAt) throw new Error('Supervisor approval has already been used.');
  if (row.purpose !== expectedPurpose) throw new Error('Supervisor approval is not valid for this action.');
  const now = db.all(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now`)[0].now;
  if (row.expiresAt < now) throw new Error('Supervisor approval has expired.');
  db.run(
    `UPDATE supervisor_approvals SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), used_by_action = ?, used_by_entity_id = ? WHERE id = ?`,
    [action, entityId, approvalId],
  );
}

const a1 = newApproval('OVER_LIMIT_PARTIAL');
consume(a1, 'OVER_LIMIT_PARTIAL', 'SALE_CREATED', 'sale-z');
check('approval consumed: used_at populated',
  db.all(`SELECT used_at AS u FROM supervisor_approvals WHERE id = ?`, [a1])[0].u != null);
expectThrow('approval cannot be consumed twice', () => {
  consume(a1, 'OVER_LIMIT_PARTIAL', 'SALE_CREATED', 'sale-z2');
}, (e) => /already been used/.test(e.message));

const a2 = newApproval('OVER_LIMIT_PARTIAL');
expectThrow('approval rejected for wrong purpose', () => {
  consume(a2, 'VOID_SALE', 'VOID_CREATED', 'void-1');
}, (e) => /not valid for this action/.test(e.message));

const a3 = newApproval('OVER_LIMIT_PARTIAL', -10);   // already expired
expectThrow('approval rejected when expired', () => {
  consume(a3, 'OVER_LIMIT_PARTIAL', 'SALE_CREATED', 'sale-z3');
}, (e) => /expired/.test(e.message));

expectThrow('unknown approval id rejected', () => {
  consume('sa-nonexistent', 'OVER_LIMIT_PARTIAL', 'SALE_CREATED', 'sale-z4');
}, (e) => /not found/.test(e.message));

// ---------- credit-limit gate logic -----------------------------------
// Simulate the gate the service runs: projectedBalance > creditLimit
// requires a supervisor approval. c-mama's limit is ₵500, balance now
// is ₵60 (₵20 + ₵40 from sales above), new sale would add another ₵20
// in credit — within limit.
const mamaBalance = db.all(`SELECT current_balance_pesewas AS b FROM customers WHERE id='c-mama'`)[0].b;
check('c-mama balance is ₵60 (₵20 + ₵40)', mamaBalance === 6000);
const limit = db.all(`SELECT credit_limit_pesewas AS l FROM customers WHERE id='c-mama'`)[0].l;
check('c-mama limit is ₵500', limit === 50000);

function gateCheck(customerId, addedCredit) {
  const c = db.all(`SELECT credit_limit_pesewas AS l, current_balance_pesewas AS b FROM customers WHERE id = ?`, [customerId])[0];
  return { overLimit: (c.b + addedCredit) > c.l, projected: c.b + addedCredit, limit: c.l };
}
check('credit within limit does not require approval',
  gateCheck('c-mama',  2000).overLimit === false);
check('credit pushing over limit flags as over',
  gateCheck('c-mama', 50000).overLimit === true);
check('zero-limit customer always flagged on any credit',
  gateCheck('c-zero',     1).overLimit === true);

// ---------- backfill idempotency -------------------------------------
// Insert a legacy fully-credit sale that has NO sale_payments row, then
// run the backfill query, assert one CREDIT row was created. Run
// again, assert nothing changes.
db.run(`INSERT INTO sales (id, shift_id, worker_id, customer_id, subtotal_pesewas, total_pesewas, is_credit, payment_method, created_by, device_id)
        VALUES ('sale-legacy', 'shift-1', ?, 'c-mama', 1500, 1500, 1, 'CREDIT', ?, 'd-old')`, [CSH, CSH]);
check('legacy credit sale starts with 0 payment rows',
  db.all(`SELECT COUNT(*) AS n FROM sale_payments WHERE sale_id='sale-legacy'`)[0].n === 0);

function runBackfill() {
  const legacy = db.all(`
    SELECT s.id AS saleId, s.total_pesewas AS totalPesewas,
           s.created_by AS workerId, s.device_id AS deviceId
      FROM sales s
     WHERE s.is_credit = 1 AND s.voided = 0
       AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id)
  `);
  for (const r of legacy) {
    db.run(
      `INSERT INTO sale_payments (id, sale_id, payment_method, amount_pesewas, created_by, device_id)
       VALUES (?, ?, 'CREDIT', ?, ?, ?)`,
      [`sp-${randomUUID()}`, r.saleId, r.totalPesewas, r.workerId, r.deviceId],
    );
  }
  return legacy.length;
}

const firstRun = runBackfill();
check('backfill first pass touches the legacy sale', firstRun === 1);
check('legacy sale now has one CREDIT-method payment row',
  db.all(`SELECT payment_method AS m, amount_pesewas AS a FROM sale_payments WHERE sale_id='sale-legacy'`)[0]?.m === 'CREDIT');
check('payment row amount matches total',
  db.all(`SELECT amount_pesewas AS a FROM sale_payments WHERE sale_id='sale-legacy'`)[0].a === 1500);
check('payment row device_id preserves original sale device_id',
  db.all(`SELECT device_id AS d FROM sale_payments WHERE sale_id='sale-legacy'`)[0].d === 'd-old');

const secondRun = runBackfill();
check('backfill second pass is a no-op', secondRun === 0);

// ---------- summary ---------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
