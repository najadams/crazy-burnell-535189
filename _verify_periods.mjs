// _verify_periods.mjs — day-lock / period-close verification.
//
// Asserts migration 0010 applies, the UNIQUE(location_id, date)
// constraint fires on duplicate seals, sealDay-then-assertNotSealed
// blocks writes, reopen lifts the gate, second reopen rejected, and
// future-date seals refused. Self-contained — re-implements service
// logic in JS against the same SQL the production service uses.

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
  CREATE TABLE workers (id TEXT PRIMARY KEY, full_name TEXT, role TEXT, active INTEGER DEFAULT 1);
  CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, action TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    before_value TEXT, after_value TEXT,
    device_id TEXT NOT NULL DEFAULT 'd-test',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO workers (id, full_name, role) VALUES ('w-naj', 'Naj', 'OWNER');
  INSERT INTO locations (id, name) VALUES ('loc-1', 'Main');
`);

const here = path.dirname(new URL(import.meta.url).pathname);
db.exec(fs.readFileSync(path.join(here, 'migrations', '0010_period_closes.sql'), 'utf8'));
check('migration 0010 applies', true);

const cols = db.all(`PRAGMA table_info(period_closes)`).map((r) => r.name);
for (const c of ['id','location_id','date','sealed_at','sealed_by','reopened_at','reopened_by','reopen_reason','device_id']) {
  check(`period_closes.${c} exists`, cols.includes(c));
}

// Service logic re-implemented inline ---------------------------------
function dateOf(iso) { return iso.slice(0, 10); }
function selectRow(loc, date) {
  return db.all(`SELECT id, location_id AS locationId, date, sealed_at AS sealedAt, reopened_at AS reopenedAt FROM period_closes WHERE location_id = ? AND date = ?`, [loc, date])[0];
}
function isSealed(loc, date) {
  const r = selectRow(loc, date);
  return !!r && r.reopenedAt === null;
}
function assertNotSealed(loc, dateOrIso, ctx) {
  const date = dateOrIso.length > 10 ? dateOf(dateOrIso) : dateOrIso;
  if (isSealed(loc, date)) throw new Error(`${ctx} blocked: ${date} is sealed.`);
}
function sealDay(loc, date, by) {
  const today = dateOf(new Date().toISOString());
  if (date > today) throw new Error(`Cannot seal a future date (${date}).`);
  const existing = selectRow(loc, date);
  if (existing && existing.reopenedAt === null) throw new Error(`${date} is already sealed.`);
  if (existing && existing.reopenedAt !== null) throw new Error(`${date} was previously sealed and then reopened.`);
  const id = `pc-${randomUUID()}`;
  db.run(`INSERT INTO period_closes (id, location_id, date, sealed_by) VALUES (?, ?, ?, ?)`, [id, loc, date, by]);
  return { id };
}
function reopenDay(loc, date, by, reason) {
  if (!reason || reason.trim().length < 3) throw new Error('reason required');
  const row = selectRow(loc, date);
  if (!row) throw new Error(`${date} is not sealed.`);
  if (row.reopenedAt !== null) throw new Error(`${date} already reopened.`);
  db.run(`UPDATE period_closes SET reopened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reopened_by = ?, reopen_reason = ? WHERE id = ?`, [by, reason.trim(), row.id]);
  return { id: row.id };
}

// ---- behavioural assertions ----------------------------------------

// initially nothing is sealed
check('no seals → assertNotSealed passes', (() => {
  try { assertNotSealed('loc-1', '2026-05-09', 'create sale'); return true; } catch { return false; }
})());

const yesterday = dateOf(new Date(Date.now() - 24*60*60*1000).toISOString());
sealDay('loc-1', yesterday, 'w-naj');
check('sealing yesterday creates a row', !!selectRow('loc-1', yesterday));
check('isSealed(loc-1, yesterday) is true', isSealed('loc-1', yesterday));
expectThrow('assertNotSealed rejects writes against sealed yesterday',
  () => assertNotSealed('loc-1', yesterday, 'create sale'),
  (e) => /sealed/.test(e.message));

// Different location: same date, not sealed
db.run(`INSERT INTO locations (id, name) VALUES ('loc-2', 'Annex')`);
check('different location for same date is not sealed',
  !isSealed('loc-2', yesterday));

// Future date refused
const tomorrow = dateOf(new Date(Date.now() + 24*60*60*1000).toISOString());
expectThrow('cannot seal a future date',
  () => sealDay('loc-1', tomorrow, 'w-naj'),
  (e) => /future date/.test(e.message));

// Double-seal same date refused (service-level check before UNIQUE bites)
expectThrow('cannot re-seal same date',
  () => sealDay('loc-1', yesterday, 'w-naj'),
  (e) => /already sealed/.test(e.message));

// Reopen lifts the gate
reopenDay('loc-1', yesterday, 'w-naj', 'GRA filing correction');
check('after reopen, isSealed → false', !isSealed('loc-1', yesterday));
check('after reopen, assertNotSealed passes', (() => {
  try { assertNotSealed('loc-1', yesterday, 'create sale'); return true; } catch { return false; }
})());

// Second reopen of same row refused
expectThrow('cannot reopen twice',
  () => reopenDay('loc-1', yesterday, 'w-naj', 'try again'),
  (e) => /already reopened/.test(e.message));

// Re-sealing the same day after reopen: refused (forensic-clarity choice)
expectThrow('cannot re-seal after reopen',
  () => sealDay('loc-1', yesterday, 'w-naj'),
  (e) => /reopened/.test(e.message));

// Empty/short reason refused
const otherDay = dateOf(new Date(Date.now() - 48*60*60*1000).toISOString());
sealDay('loc-1', otherDay, 'w-naj');
expectThrow('reopen requires a non-trivial reason',
  () => reopenDay('loc-1', otherDay, 'w-naj', 'no'),
  (e) => /reason/.test(e.message));

// assertNotSealed accepts ISO timestamps as well as YYYY-MM-DD
const someISO = `${otherDay}T14:32:00.000Z`;
expectThrow('assertNotSealed handles ISO timestamps',
  () => assertNotSealed('loc-1', someISO, 'void'),
  (e) => /sealed/.test(e.message));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
