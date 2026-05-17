// _verify_recovery.mjs — OWNER PIN recovery flow verification.
//
// Asserts migration 0009 applies, the recovery service generates a
// valid plaintext code, verifies it (with hyphens and case stripped),
// rotates the code on use (old plaintext can't be replayed), refuses
// non-OWNER targets, and surfaces a clean error when no code is on
// file. Re-implements the service logic in JS at the same SQL surface
// the production service uses; bcryptjs runs identically in WASM.

import pkg from 'node-sqlite3-wasm';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomFillSync } from 'node:crypto';
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

// ---- minimal prior schema ---------------------------------------------
// workers table at the post-0002 + post-0009 shape we need.
db.exec(`
  CREATE TABLE workers (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    recovery_code_hash TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT, updated_by TEXT
  );
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY, worker_id TEXT NOT NULL,
    action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    before_value TEXT, after_value TEXT,
    device_id TEXT NOT NULL DEFAULT 'd-test',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// apply migration 0009 verbatim
const here = path.dirname(new URL(import.meta.url).pathname);
db.exec(fs.readFileSync(path.join(here, 'migrations', '0009_recovery_code_metadata.sql'), 'utf8'));
check('migration 0009 applies', true);

// ---- schema assertions ------------------------------------------------
const cols = db.all(`PRAGMA table_info(workers)`).map((r) => r.name);
check('workers.recovery_code_issued_at added', cols.includes('recovery_code_issued_at'));
check('workers.recovery_code_issued_by added', cols.includes('recovery_code_issued_by'));

// ---- fixtures ----------------------------------------------------------
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-naj', 'Naj', 'OWNER', ?)`,
  [bcrypt.hashSync('1234', 6)]);
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-mary', 'Mary', 'CASHIER', ?)`,
  [bcrypt.hashSync('4321', 6)]);
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-found', 'Founder', 'FOUNDER', ?)`,
  [bcrypt.hashSync('9999', 6)]);

// ---- service logic, re-implemented for smoke ---------------------------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 16;
const HASH_ROUNDS = 6;  // 6 instead of 12 to keep smoke fast in WASM

function generatePlaintextCode() {
  const buf = new Uint32Array(CODE_LENGTH);
  randomFillSync(buf);
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return `${s.slice(0,4)}-${s.slice(4,8)}-${s.slice(8,12)}-${s.slice(12,16)}`;
}
function normalise(c) { return c.replace(/[\s-]/g, '').toUpperCase(); }

function generateRecoveryCode(targetId, issuerId) {
  const target = db.all(`SELECT id, role FROM workers WHERE id = ? AND active = 1`, [targetId])[0];
  if (!target) throw new Error('Worker not found.');
  if (!['OWNER','FOUNDER'].includes(target.role)) {
    throw new Error('Recovery codes are only issued for OWNER or FOUNDER workers.');
  }
  const plaintext = generatePlaintextCode();
  const hash = bcrypt.hashSync(normalise(plaintext), HASH_ROUNDS);
  db.run(
    `UPDATE workers SET recovery_code_hash = ?, recovery_code_issued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), recovery_code_issued_by = ? WHERE id = ?`,
    [hash, issuerId, targetId],
  );
  return { code: plaintext };
}
function verifyAndReset(targetId, submitted, newPin) {
  if (typeof newPin !== 'string' || newPin.length < 4) throw new Error('New PIN must be at least 4 digits.');
  const target = db.all(`SELECT id, role, recovery_code_hash AS h FROM workers WHERE id = ? AND active = 1`, [targetId])[0];
  if (!target) throw new Error('Worker not found.');
  if (!['OWNER','FOUNDER'].includes(target.role)) throw new Error('Recovery flow is only available for OWNER or FOUNDER workers.');
  if (!target.h) throw new Error('No recovery code on file. The OWNER must regenerate from Settings.');
  if (!bcrypt.compareSync(normalise(submitted), target.h)) throw new Error('Recovery code does not match.');
  const newPinHash = bcrypt.hashSync(newPin, HASH_ROUNDS);
  const newCode = generatePlaintextCode();
  const newHash = bcrypt.hashSync(normalise(newCode), HASH_ROUNDS);
  db.run(`UPDATE workers SET pin_hash = ?, recovery_code_hash = ? WHERE id = ?`, [newPinHash, newHash, targetId]);
  return { newRecoveryCode: newCode };
}

// ---- behavioural assertions -------------------------------------------
const { code: c1 } = generateRecoveryCode('w-naj', 'w-naj');
check('issued code matches XXXX-XXXX-XXXX-XXXX format', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c1));
check('alphabet excludes confusing characters O 0 I 1', !/[OI01]/.test(c1.replace(/-/g, '')));

// Verify with the exact issued plaintext
const { newRecoveryCode: c2 } = verifyAndReset('w-naj', c1, '5678');
check('verify with correct code succeeds and returns a new code', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c2));
check('rotated code differs from the original', c1 !== c2);

// PIN was actually reset
const pinHashAfter = db.all(`SELECT pin_hash AS h FROM workers WHERE id = 'w-naj'`)[0].h;
check('PIN reset succeeded (bcrypt-verifies against new PIN)', bcrypt.compareSync('5678', pinHashAfter));
check('old PIN no longer matches', !bcrypt.compareSync('1234', pinHashAfter));

// Old code is dead — replay should fail
expectThrow('old recovery code cannot be replayed after rotation',
  () => verifyAndReset('w-naj', c1, '9876'),
  (e) => /does not match/.test(e.message));

// Verify normalisation: hyphens and case stripped on compare
generateRecoveryCode('w-naj', 'w-naj');
const code3 = db.all(`SELECT recovery_code_hash AS h FROM workers WHERE id = 'w-naj'`)[0].h;
// Re-derive a code we can test normalisation against
const { code: c4 } = generateRecoveryCode('w-naj', 'w-naj');
const lowered = c4.toLowerCase();
const noHyphens = c4.replace(/-/g, '');
const messy = '  ' + c4.toLowerCase().replace(/-/g, ' - ') + '  ';
check('normalisation: lowercase code matches', bcrypt.compareSync(normalise(lowered), db.all(`SELECT recovery_code_hash AS h FROM workers WHERE id = 'w-naj'`)[0].h));
check('normalisation: no-hyphen code matches', bcrypt.compareSync(normalise(noHyphens), db.all(`SELECT recovery_code_hash AS h FROM workers WHERE id = 'w-naj'`)[0].h));
check('normalisation: messy spacing matches', bcrypt.compareSync(normalise(messy), db.all(`SELECT recovery_code_hash AS h FROM workers WHERE id = 'w-naj'`)[0].h));

// Non-OWNER target is rejected
expectThrow('issuing for CASHIER throws',
  () => generateRecoveryCode('w-mary', 'w-naj'),
  (e) => /OWNER or FOUNDER/.test(e.message));
expectThrow('reset for CASHIER throws',
  () => verifyAndReset('w-mary', 'XXXX-XXXX-XXXX-XXXX', '5555'),
  (e) => /OWNER or FOUNDER/.test(e.message));

// FOUNDER works — same rules as OWNER
const { code: cF } = generateRecoveryCode('w-found', 'w-naj');
check('FOUNDER recovery code issued', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(cF));
const { newRecoveryCode: cF2 } = verifyAndReset('w-found', cF, '0000');
check('FOUNDER verify+reset succeeds', cF2 !== cF);

// No code on file → clear error rather than "does not match"
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-fresh', 'Fresh Owner', 'OWNER', ?)`, [bcrypt.hashSync('0000', 6)]);
expectThrow('worker with no code surfaces "No recovery code on file"',
  () => verifyAndReset('w-fresh', 'ABCD-EFGH-JKLM-NPQR', '1111'),
  (e) => /No recovery code on file/.test(e.message));

// Short PIN rejected
generateRecoveryCode('w-naj', 'w-naj');
const cShort = db.all(`SELECT recovery_code_hash AS h FROM workers WHERE id = 'w-naj'`)[0].h;
expectThrow('new PIN < 4 digits rejected',
  () => verifyAndReset('w-naj', 'irrelevant', '12'),
  (e) => /at least 4 digits/.test(e.message));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
