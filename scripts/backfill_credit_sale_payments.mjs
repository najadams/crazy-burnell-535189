// scripts/backfill_credit_sale_payments.mjs
//
// One-shot backfill that makes legacy credit sales conform to the
// post-0007 invariant: every non-voided sale has sale_payments rows
// summing to its total. Pre-0007 fully-credit sales carry no payment
// rows; this script inserts one CREDIT-method sale_payments row per
// such sale.
//
// Safe to run multiple times: the "missing rows" filter makes re-runs
// no-ops. Voided sales are skipped (the void path doesn't owe a
// payment row).
//
// Usage:
//   node scripts/backfill_credit_sale_payments.mjs <path-to-counter.db> [--operator <worker-id>] [--dry-run]
//
// The operator worker id is recorded on the audit row and on each new
// sale_payments row's created_by. Defaults to the first active OWNER
// in the workers table.

import pkg from 'node-sqlite3-wasm';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const { Database } = pkg;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: node scripts/backfill_credit_sale_payments.mjs <db-path> [--operator <worker-id>] [--dry-run]',
  );
  process.exit(0);
}

const dbPath = args[0];
const dryRun = args.includes('--dry-run');
const operatorFlagIdx = args.indexOf('--operator');
const operatorOverride = operatorFlagIdx >= 0 ? args[operatorFlagIdx + 1] : null;

if (!fs.existsSync(dbPath)) {
  console.error(`Database file not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);

// Confirm the migration has been applied. If sale_payments doesn't
// exist, refuse — the user is running this against a pre-migration DB
// and would just hit a SQL error halfway through.
const tableExists = db.all(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='sale_payments'`,
).length > 0;
if (!tableExists) {
  console.error(
    'sale_payments table does not exist — apply migration 0007 first.',
  );
  process.exit(1);
}

// Resolve the operator. Either an explicit --operator or the first
// active OWNER. We need a real worker_id because both the audit row
// and the new sale_payments rows have FKs to workers(id).
let operatorId = operatorOverride;
if (!operatorId) {
  const ownerRow = db.all(
    `SELECT id FROM workers WHERE active = 1 AND role = 'OWNER' ORDER BY created_at ASC LIMIT 1`,
  )[0];
  if (!ownerRow) {
    console.error(
      'No active OWNER found to attribute the backfill. Pass --operator <worker-id>.',
    );
    process.exit(1);
  }
  operatorId = ownerRow.id;
}

// Verify the operator exists. Saves a useless error mid-backfill.
const operatorExists = db.all(
  `SELECT id, full_name AS fullName FROM workers WHERE id = ?`,
  [operatorId],
)[0];
if (!operatorExists) {
  console.error(`Operator worker not found: ${operatorId}`);
  process.exit(1);
}

// Find legacy credit sales: is_credit=1, voided=0, no sale_payments row.
const legacy = db.all(`
  SELECT s.id AS saleId,
         s.total_pesewas AS totalPesewas,
         s.created_by AS originalWorkerId,
         s.device_id AS deviceId
    FROM sales s
   WHERE s.is_credit = 1
     AND s.voided = 0
     AND NOT EXISTS (
       SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id
     )
   ORDER BY s.created_at ASC
`);

console.log(`Found ${legacy.length} legacy credit sale(s) needing a CREDIT-method sale_payments row.`);
if (legacy.length === 0) {
  console.log('Nothing to backfill. Exit.');
  process.exit(0);
}
if (dryRun) {
  console.log('--dry-run: not writing. First few:');
  for (const r of legacy.slice(0, 5)) console.log(`  ${r.saleId}  ₵${(r.totalPesewas / 100).toFixed(2)}`);
  process.exit(0);
}

// Single transaction so a mid-run crash leaves no half-state. SQLite
// handles tens of thousands of inserts in one tx without trouble.
db.exec('BEGIN');
try {
  for (const row of legacy) {
    const spId = `sp-${randomUUID()}`;
    db.run(
      `INSERT INTO sale_payments
         (id, sale_id, payment_method, amount_pesewas,
          payment_reference, cash_given_pesewas,
          created_by, device_id)
       VALUES (?, ?, 'CREDIT', ?, NULL, NULL, ?, ?)`,
      // created_by is the original cashier so the row inherits the
      // attribution of the sale it backfills. device_id likewise.
      [spId, row.saleId, row.totalPesewas, row.originalWorkerId, row.deviceId],
    );
  }

  // Single audit row summarising the batch. Per-sale rows would be
  // noise; the count + operator + timestamp is enough to make the
  // backfill traceable.
  db.run(
    `INSERT INTO audit_log
       (id, worker_id, action, entity_type, entity_id,
        before_value, after_value, device_id)
     VALUES (?, ?, 'BACKFILL_CREDIT_SALE_PAYMENTS', 'sale_payments', 'batch', NULL, ?, 'backfill-tool')`,
    [
      `al-${randomUUID()}`, operatorId,
      JSON.stringify({ count: legacy.length, dbPath }),
    ],
  );
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Backfill failed mid-way; rolled back.', e);
  process.exit(1);
}

console.log(`Inserted ${legacy.length} CREDIT-method sale_payments rows. Operator: ${operatorExists.fullName} (${operatorId}).`);

// Sanity post-check: re-count legacy rows. Should be zero.
const remaining = db.all(`
  SELECT COUNT(*) AS n
    FROM sales s
   WHERE s.is_credit = 1
     AND s.voided = 0
     AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id)
`)[0].n;
console.log(`Legacy credit sales without payment rows after backfill: ${remaining}`);
process.exit(remaining === 0 ? 0 : 2);
