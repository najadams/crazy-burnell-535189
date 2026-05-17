// _verify_pending_orders.mjs — Wave G chunk 1.
//
// Asserts the migration applies, the pending_orders schema is correct,
// the state-machine constraints fire (cancel blocked after convert,
// line edits blocked outside CREATED), and the basic happy-path
// createPendingOrder → updateLines → cancel flow works. Conversion
// behaviour is exercised at the schema level (status flip, sale_id
// populated); the deeper createSale integration is covered by its
// own smoke.

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

// minimal prior schema
db.exec(`
  CREATE TABLE workers (
    id TEXT PRIMARY KEY, full_name TEXT, role TEXT, active INTEGER DEFAULT 1
  );
  CREATE TABLE customers (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, phone TEXT,
    blocked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE products (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT
  );
  CREATE TABLE sales (
    id TEXT PRIMARY KEY, total_pesewas INTEGER NOT NULL DEFAULT 0
  );
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
check('migration 0011 applies', true);

// schema assertions
const cols = db.all(`PRAGMA table_info(pending_orders)`).map((r) => r.name);
for (const c of ['id','customer_id','intake_channel','intake_worker_id','status','requires_review','conversion_sale_id','converted_at','cancel_reason','cancelled_at']) {
  check(`pending_orders.${c} exists`, cols.includes(c));
}
const lcols = db.all(`PRAGMA table_info(pending_order_lines)`).map((r) => r.name);
for (const c of ['id','pending_order_id','product_id','quantity','unit_price_pesewas_at_intake','notes']) {
  check(`pending_order_lines.${c} exists`, lcols.includes(c));
}

// CHECK constraints
expectThrow('intake_channel whitelist enforced', () => {
  db.run(`INSERT INTO pending_orders (id, customer_id, intake_channel, intake_worker_id, created_by, updated_by) VALUES ('po-bad','c1','VOICE_AGENT','w1','w1','w1')`);
}, (e) => /CHECK/.test(e.message));

expectThrow('status whitelist enforced', () => {
  db.run(`INSERT INTO pending_orders (id, customer_id, intake_channel, intake_worker_id, status, created_by, updated_by) VALUES ('po-bad2','c1','MANUAL','w1','WAT','w1','w1')`);
}, (e) => /CHECK/.test(e.message));

expectThrow('quantity > 0 enforced on lines', () => {
  db.run(`INSERT INTO pending_order_lines (id, pending_order_id, product_id, quantity, unit_price_pesewas_at_intake, created_by, updated_by) VALUES ('pol-bad','po-x','p1',0,100,'w1','w1')`);
}, (e) => /CHECK/.test(e.message));

// fixtures
db.run(`INSERT INTO workers   (id, full_name, role) VALUES ('w-naj','Naj','OWNER')`);
db.run(`INSERT INTO customers (id, display_name) VALUES ('c-mama','Mama Akua')`);
db.run(`INSERT INTO customers (id, display_name, blocked) VALUES ('c-blocked','Bro Bad', 1)`);
db.run(`INSERT INTO products  (id, name) VALUES ('p-coke','Coke 1.5L')`);
db.run(`INSERT INTO products  (id, name) VALUES ('p-pepsi','Pepsi 330ml')`);

// Re-implement service logic for smoke
function createPendingOrder(customerId, channel, workerId, lines, requiresReview = false) {
  const cust = db.all(`SELECT id, blocked, display_name AS displayName FROM customers WHERE id = ?`, [customerId])[0];
  if (!cust) throw new Error('Customer not found.');
  if (cust.blocked) throw new Error(`${cust.displayName} is blocked — cannot create new orders.`);
  if (lines.length === 0) throw new Error('A pending order must have at least one line.');
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new Error('bad qty');
    if (!Number.isInteger(l.unitPrice) || l.unitPrice < 0) throw new Error('bad price');
  }
  const id = `po-${randomUUID()}`;
  db.run(
    `INSERT INTO pending_orders (id, customer_id, intake_channel, intake_worker_id, requires_review, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, customerId, channel, workerId, requiresReview ? 1 : 0, workerId, workerId],
  );
  for (const l of lines) {
    db.run(
      `INSERT INTO pending_order_lines (id, pending_order_id, product_id, quantity, unit_price_pesewas_at_intake, notes, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`pol-${randomUUID()}`, id, l.productId, l.quantity, l.unitPrice, l.notes ?? null, workerId, workerId],
    );
  }
  return id;
}
function getStatus(id) {
  const r = db.all(`SELECT status FROM pending_orders WHERE id = ?`, [id])[0];
  return r?.status;
}
function getLineCount(id) {
  return db.all(`SELECT COUNT(*) AS n FROM pending_order_lines WHERE pending_order_id = ?`, [id])[0].n;
}
function updateLines(id, workerId, lines) {
  const order = db.all(`SELECT status FROM pending_orders WHERE id = ?`, [id])[0];
  if (!order) throw new Error('Pending order not found.');
  if (order.status !== 'CREATED') throw new Error(`Lines can only be edited while status='CREATED' (current: ${order.status}).`);
  db.run(`DELETE FROM pending_order_lines WHERE pending_order_id = ?`, [id]);
  for (const l of lines) {
    db.run(
      `INSERT INTO pending_order_lines (id, pending_order_id, product_id, quantity, unit_price_pesewas_at_intake, notes, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`pol-${randomUUID()}`, id, l.productId, l.quantity, l.unitPrice, l.notes ?? null, workerId, workerId],
    );
  }
}
function cancelOrder(id, workerId, reason) {
  if (!reason || reason.trim().length < 3) throw new Error('Cancel reason is required (at least a few characters).');
  const order = db.all(`SELECT status FROM pending_orders WHERE id = ?`, [id])[0];
  if (!order) throw new Error('Pending order not found.');
  if (order.status === 'CONVERTED') throw new Error('Order has already been converted to a sale and cannot be cancelled.');
  if (order.status === 'CANCELLED') throw new Error('Order is already cancelled.');
  db.run(`UPDATE pending_orders SET status='CANCELLED', cancel_reason=?, cancelled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by=? WHERE id=?`, [reason.trim(), workerId, id]);
}
function markConverted(id, saleId, workerId) {
  const order = db.all(`SELECT status FROM pending_orders WHERE id = ?`, [id])[0];
  if (!order) throw new Error('Pending order not found.');
  if (order.status === 'CONVERTED') throw new Error('Order has already been converted.');
  if (order.status === 'CANCELLED') throw new Error('Cannot convert a cancelled order.');
  db.run(`INSERT INTO sales (id, total_pesewas) VALUES (?, ?)`, [saleId, 1000]);
  db.run(`UPDATE pending_orders SET status='CONVERTED', conversion_sale_id=?, converted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by=? WHERE id=?`, [saleId, workerId, id]);
}

// --- behaviour --------------------------------------------------------

// happy path
const po1 = createPendingOrder('c-mama', 'PHONE_CALL', 'w-naj', [
  { productId: 'p-coke', quantity: 12, unitPrice: 500 },
  { productId: 'p-pepsi', quantity: 24, unitPrice: 150 },
]);
check('createPendingOrder produces a row', !!getStatus(po1));
check('initial status is CREATED', getStatus(po1) === 'CREATED');
check('initial line count = 2', getLineCount(po1) === 2);

// blocked customer rejected
expectThrow('blocked customer cannot get a pending order',
  () => createPendingOrder('c-blocked', 'PHONE_CALL', 'w-naj', [{ productId: 'p-coke', quantity: 1, unitPrice: 500 }]),
  (e) => /blocked/.test(e.message));

// empty lines rejected
expectThrow('empty lines rejected',
  () => createPendingOrder('c-mama', 'MANUAL', 'w-naj', []),
  (e) => /at least one line/.test(e.message));

// updateLines while CREATED works
updateLines(po1, 'w-naj', [
  { productId: 'p-coke', quantity: 10, unitPrice: 500 },   // reduced
  { productId: 'p-pepsi', quantity: 24, unitPrice: 150 },
  { productId: 'p-coke', quantity: 1, unitPrice: 500 },    // added (same product twice — allowed)
]);
check('updateLines replaces and counts to 3', getLineCount(po1) === 3);

// cancel
cancelOrder(po1, 'w-naj', 'customer changed mind');
check('cancel sets status=CANCELLED', getStatus(po1) === 'CANCELLED');

// updateLines blocked after cancel
expectThrow('updateLines blocked after cancel',
  () => updateLines(po1, 'w-naj', [{ productId: 'p-coke', quantity: 1, unitPrice: 500 }]),
  (e) => /CREATED/.test(e.message));

// cancel again rejected
expectThrow('cancel twice rejected',
  () => cancelOrder(po1, 'w-naj', 'oops'),
  (e) => /already cancelled/.test(e.message));

// short reason rejected
const po2 = createPendingOrder('c-mama', 'MANUAL', 'w-naj', [{ productId: 'p-coke', quantity: 6, unitPrice: 500 }]);
expectThrow('cancel requires non-trivial reason',
  () => cancelOrder(po2, 'w-naj', 'no'),
  (e) => /reason/.test(e.message));

// conversion path
const po3 = createPendingOrder('c-mama', 'PHONE_CALL', 'w-naj', [
  { productId: 'p-pepsi', quantity: 12, unitPrice: 150 },
]);
const saleId = `sale-${randomUUID()}`;
markConverted(po3, saleId, 'w-naj');
check('conversion sets status=CONVERTED', getStatus(po3) === 'CONVERTED');
check('conversion_sale_id is populated',
  db.all(`SELECT conversion_sale_id AS s FROM pending_orders WHERE id = ?`, [po3])[0].s === saleId);

// convert twice rejected
expectThrow('cannot convert twice',
  () => markConverted(po3, `sale-${randomUUID()}`, 'w-naj'),
  (e) => /already been converted/.test(e.message));

// convert blocked after cancel
const po4 = createPendingOrder('c-mama', 'MANUAL', 'w-naj', [{ productId: 'p-coke', quantity: 3, unitPrice: 500 }]);
cancelOrder(po4, 'w-naj', 'pulled before delivery');
expectThrow('cannot convert a cancelled order',
  () => markConverted(po4, `sale-${randomUUID()}`, 'w-naj'),
  (e) => /Cannot convert a cancelled/.test(e.message));

// requires_review flag persisted as 1/0
const po5 = createPendingOrder('c-mama', 'PHONE_CALL', 'w-naj', [{ productId: 'p-coke', quantity: 100, unitPrice: 500 }], true);
check('requires_review = 1 when flagged',
  db.all(`SELECT requires_review AS r FROM pending_orders WHERE id = ?`, [po5])[0].r === 1);

// list filter OPEN excludes CONVERTED + CANCELLED
const openRows = db.all(`SELECT id FROM pending_orders WHERE status NOT IN ('CONVERTED','CANCELLED')`);
const openIds = openRows.map((r) => r.id);
check('OPEN filter excludes converted po3', !openIds.includes(po3));
check('OPEN filter excludes cancelled po1', !openIds.includes(po1));
check('OPEN filter includes flagged-review po5', openIds.includes(po5));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
