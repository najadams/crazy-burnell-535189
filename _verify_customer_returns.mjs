// _verify_customer_returns.mjs — Wave C.3 customer returns.
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
for (const m of ['0001_lookup_tables','0002_workers','0003_master_data','0004_shifts_sales_stock','0005_wave_h_prereqs','0006_customer_payments','0008_supervisor_approvals','0015_stocktake','0017_customer_return_lines']) {
  db.exec(fs.readFileSync(path.join(here, 'migrations', m + '.sql'), 'utf8'));
}
check('migrations apply', true);

const crCols = db.all(`PRAGMA table_info(customer_returns)`).map((r) => r.name);
for (const c of ['id','customer_id','refund_method','total_refund_pesewas','supervisor_approval_id','shift_id','location_id']) {
  check(`customer_returns.${c}`, crCols.includes(c));
}
const lCols = db.all(`PRAGMA table_info(customer_return_lines)`).map((r) => r.name);
for (const c of ['id','customer_return_id','product_id','quantity','refund_unit_pesewas','line_total_pesewas']) {
  check(`customer_return_lines.${c}`, lCols.includes(c));
}

// fixtures
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-naj','Naj','OWNER','x')`);
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-sup','Ama','SUPERVISOR','x')`);
db.run(`INSERT INTO locations (id, name, created_by, updated_by) VALUES ('loc-1','Main','w-naj','w-naj')`);
db.run(`INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas, current_balance_pesewas, created_by, updated_by) VALUES ('c-a','Mama Akua','+233244111222','WHOLESALE',50000,5000,'w-naj','w-naj')`);
db.run(`INSERT INTO products (id, sku, name, category, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas, cost_price_pesewas, created_by, updated_by) VALUES ('p-coke','COKE','Coke','SD',1000,800,900,500,'w-naj','w-naj')`);
db.run(`INSERT INTO shifts (id, worker_id, location_id) VALUES ('shift-1','w-naj','loc-1')`);

// CHECK constraints
expectThrow('quantity > 0 enforced', () => {
  db.run(`INSERT INTO customer_return_lines (id, customer_return_id, product_id, quantity, refund_unit_pesewas, line_total_pesewas, created_by) VALUES ('crl-bad','cr-x','p-coke',0,100,0,'w-naj')`);
}, (e) => /CHECK/.test(e.message));

expectThrow('line_total = qty * unit enforced', () => {
  db.run(`INSERT INTO customer_returns (id, customer_id, refund_method, total_refund_pesewas, created_by, shift_id, location_id) VALUES ('cr-y','c-a','CASH',500,'w-naj','shift-1','loc-1')`);
  db.run(`INSERT INTO customer_return_lines (id, customer_return_id, product_id, quantity, refund_unit_pesewas, line_total_pesewas, created_by) VALUES ('crl-bad2','cr-y','p-coke',3,500,999,'w-naj')`);
}, (e) => /CHECK/.test(e.message));
// clean up
db.run(`DELETE FROM customer_returns WHERE id='cr-y'`);

// refund_method enum
expectThrow('refund_method whitelist enforced', () => {
  db.run(`INSERT INTO customer_returns (id, customer_id, refund_method, total_refund_pesewas, created_by) VALUES ('cr-bad','c-a','CHEQUE',500,'w-naj')`);
}, (e) => /CHECK/.test(e.message));

// CUSTOMER_RETURN supervisor approval purpose
db.run(`INSERT INTO supervisor_approvals (id, supervisor_worker_id, purpose, expires_at, created_by) VALUES ('sa-1','w-sup','CUSTOMER_RETURN',strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),'w-naj')`);
check('CUSTOMER_RETURN approval purpose accepted', db.all(`SELECT id FROM supervisor_approvals WHERE id='sa-1'`).length === 1);

// Service-level happy path: CASH refund. Re-implement inline.
function recordReturn({ customerId, method, lines, shiftId='shift-1', locationId='loc-1', approvalId='sa-1' }) {
  if (lines.length === 0) throw new Error('A return must have at least one line.');
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new Error('bad qty');
    if (!Number.isInteger(l.refundUnitPesewas) || l.refundUnitPesewas < 0) throw new Error('bad price');
  }
  if (method === 'STORE') throw new Error('STORE refund method is not yet supported.');
  // mock the consume-approval check
  const a = db.all(`SELECT used_at FROM supervisor_approvals WHERE id = ?`, [approvalId])[0];
  if (!a) throw new Error('approval not found');
  if (a.used_at) throw new Error('Supervisor approval has already been used.');
  const total = lines.reduce((s, l) => s + l.quantity * l.refundUnitPesewas, 0);
  if (total <= 0) throw new Error('Total refund must be greater than zero.');
  const id = `cr-${randomUUID()}`;
  db.run(`UPDATE supervisor_approvals SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), used_by_action='CUSTOMER_RETURN_RECORDED', used_by_entity_id=? WHERE id = ?`, [id, approvalId]);
  db.run(`INSERT INTO customer_returns (id, customer_id, refund_method, total_refund_pesewas, supervisor_approval_id, shift_id, location_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'w-naj')`, [id, customerId, method, total, approvalId, shiftId, locationId]);
  for (const l of lines) {
    db.run(`INSERT INTO customer_return_lines (id, customer_return_id, product_id, quantity, refund_unit_pesewas, line_total_pesewas, created_by) VALUES (?, ?, ?, ?, ?, ?, 'w-naj')`, [`crl-${randomUUID()}`, id, l.productId, l.quantity, l.refundUnitPesewas, l.quantity * l.refundUnitPesewas]);
    db.run(`INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code, shift_id, worker_id, created_by) VALUES (?, ?, ?, ?, 'RETURN_FROM_CUSTOMER', ?, 'w-naj', 'w-naj')`, [`sm-${randomUUID()}`, l.productId, locationId, l.quantity, shiftId]);
  }
  if (method === 'CASH') {
    db.run(`INSERT INTO cash_counts (id, shift_id, count_type, amount_pesewas, notes, created_by) VALUES (?, ?, 'CASH_DROP', ?, ?, 'w-naj')`, [`cc-${randomUUID()}`, shiftId, total, `customer-refund:${customerId}:${id}`]);
  } else if (method === 'CREDIT') {
    db.run(`INSERT INTO customer_payments (id, customer_id, shift_id, payment_method, amount_pesewas, notes, created_by) VALUES (?, ?, ?, 'RETURN_CREDIT', ?, ?, 'w-naj')`, [`cp-${randomUUID()}`, customerId, shiftId, total, `customer return ${id}`]);
    db.run(`UPDATE customers SET current_balance_pesewas = current_balance_pesewas - ? WHERE id = ?`, [total, customerId]);
  }
  return { customerReturnId: id, totalRefundPesewas: total };
}

// CASH refund: stock restored + cash_counts CASH_DROP written
const before = db.all(`SELECT COALESCE(SUM(quantity),0) AS q FROM stock_movements WHERE product_id='p-coke' AND reason_code='RETURN_FROM_CUSTOMER'`)[0].q;
const beforeDrops = db.all(`SELECT COUNT(*) AS n FROM cash_counts WHERE count_type='CASH_DROP'`)[0].n;
const r1 = recordReturn({ customerId: 'c-a', method: 'CASH', lines: [{ productId: 'p-coke', quantity: 6, refundUnitPesewas: 800 }] });
const afterDrops = db.all(`SELECT COUNT(*) AS n FROM cash_counts WHERE count_type='CASH_DROP'`)[0].n;
check('CASH return: 6 units returned to stock',
  db.all(`SELECT COALESCE(SUM(quantity),0) AS q FROM stock_movements WHERE product_id='p-coke' AND reason_code='RETURN_FROM_CUSTOMER'`)[0].q - before === 6);
check('CASH return: cash_counts CASH_DROP written', afterDrops - beforeDrops === 1);
check('CASH return: drop notes contain customer-refund tag',
  db.all(`SELECT notes FROM cash_counts WHERE count_type='CASH_DROP' ORDER BY created_at DESC LIMIT 1`)[0].notes.startsWith('customer-refund:c-a:'));
check('CASH return total = 6 × ₵8 = ₵48',
  r1.totalRefundPesewas === 4800);

// Approval consumed — can't reuse
expectThrow('cannot reuse a consumed approval',
  () => recordReturn({ customerId: 'c-a', method: 'CASH', lines: [{ productId: 'p-coke', quantity: 1, refundUnitPesewas: 100 }] }),
  (e) => /already been used/.test(e.message));

// CREDIT refund: customer balance decreases
db.run(`INSERT INTO supervisor_approvals (id, supervisor_worker_id, purpose, expires_at, created_by) VALUES ('sa-2','w-sup','CUSTOMER_RETURN',strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),'w-naj')`);
const balBefore = db.all(`SELECT current_balance_pesewas AS b FROM customers WHERE id = 'c-a'`)[0].b;
recordReturn({ customerId: 'c-a', method: 'CREDIT', approvalId: 'sa-2', lines: [{ productId: 'p-coke', quantity: 2, refundUnitPesewas: 800 }] });
const balAfter = db.all(`SELECT current_balance_pesewas AS b FROM customers WHERE id = 'c-a'`)[0].b;
check('CREDIT return: balance decreased by refund total (2 × ₵8 = ₵16)',
  balBefore - balAfter === 1600);
check('CREDIT return: customer_payments RETURN_CREDIT row written',
  db.all(`SELECT COUNT(*) AS n FROM customer_payments WHERE customer_id='c-a' AND payment_method='RETURN_CREDIT'`)[0].n === 1);

// STORE rejected
db.run(`INSERT INTO supervisor_approvals (id, supervisor_worker_id, purpose, expires_at, created_by) VALUES ('sa-3','w-sup','CUSTOMER_RETURN',strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),'w-naj')`);
expectThrow('STORE refund method rejected',
  () => recordReturn({ customerId: 'c-a', method: 'STORE', approvalId: 'sa-3', lines: [{ productId: 'p-coke', quantity: 1, refundUnitPesewas: 100 }] }),
  (e) => /STORE refund method is not yet supported/.test(e.message));

// Empty lines rejected
expectThrow('empty lines rejected',
  () => recordReturn({ customerId: 'c-a', method: 'CASH', approvalId: 'sa-3', lines: [] }),
  (e) => /at least one line/.test(e.message));

// Zero-total rejected
db.run(`INSERT INTO supervisor_approvals (id, supervisor_worker_id, purpose, expires_at, created_by) VALUES ('sa-4','w-sup','CUSTOMER_RETURN',strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),'w-naj')`);
expectThrow('zero total refund rejected',
  () => recordReturn({ customerId: 'c-a', method: 'CASH', approvalId: 'sa-4', lines: [{ productId: 'p-coke', quantity: 5, refundUnitPesewas: 0 }] }),
  (e) => /Total refund must be greater than zero/.test(e.message));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
