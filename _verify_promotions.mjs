// _verify_promotions.mjs — Wave D bonus-unit promotions.
// Asserts the schema + the greedy-on-largest-qty_buy algorithm.

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
for (const m of ['0001_lookup_tables','0002_workers','0003_master_data','0004_shifts_sales_stock','0016_promotions']) {
  db.exec(fs.readFileSync(path.join(here, 'migrations', m + '.sql'), 'utf8'));
}
check('migrations apply', true);

const cols = db.all(`PRAGMA table_info(promotions)`).map((r) => r.name);
for (const c of ['id','product_id','channel','qty_buy','qty_get_free','valid_from','valid_to','active']) {
  check(`promotions.${c} exists`, cols.includes(c));
}

// fixtures
db.run(`INSERT INTO workers (id, full_name, role, pin_hash) VALUES ('w-naj','Naj','OWNER','x')`);
db.run(`INSERT INTO products (id, sku, name, category, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas, cost_price_pesewas, created_by, updated_by) VALUES ('p-coke','COKE','Coke','SD',1000,800,900,500,'w-naj','w-naj')`);
db.run(`INSERT INTO products (id, sku, name, category, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas, cost_price_pesewas, created_by, updated_by) VALUES ('p-pepsi','PEPSI','Pepsi','SD',300,200,250,150,'w-naj','w-naj')`);

// schema-level CHECK constraints
expectThrow('qty_buy > 0 enforced', () => {
  db.run(`INSERT INTO promotions (id, product_id, qty_buy, qty_get_free, valid_from, created_by, updated_by) VALUES ('pr-bad','p-coke',0,1,'2026-05-11','w-naj','w-naj')`);
}, (e) => /CHECK/.test(e.message));
expectThrow('qty_get_free > 0 enforced', () => {
  db.run(`INSERT INTO promotions (id, product_id, qty_buy, qty_get_free, valid_from, created_by, updated_by) VALUES ('pr-bad2','p-coke',12,0,'2026-05-11','w-naj','w-naj')`);
}, (e) => /CHECK/.test(e.message));
expectThrow('channel whitelist enforced', () => {
  db.run(`INSERT INTO promotions (id, product_id, channel, qty_buy, qty_get_free, valid_from, created_by, updated_by) VALUES ('pr-bad3','p-coke','UBER',12,1,'2026-05-11','w-naj','w-naj')`);
}, (e) => /CHECK/.test(e.message));
expectThrow('valid_from length CHECK enforced (must be 10 chars)', () => {
  db.run(`INSERT INTO promotions (id, product_id, qty_buy, qty_get_free, valid_from, created_by, updated_by) VALUES ('pr-bad4','p-coke',12,1,'2026-1-1','w-naj','w-naj')`);
}, (e) => /CHECK/.test(e.message));

// Seed three promos on coke + one on pepsi
function addPromo(id, productId, channel, qtyBuy, qtyGetFree, validFrom, validTo = null) {
  db.run(`INSERT INTO promotions (id, product_id, channel, qty_buy, qty_get_free, valid_from, valid_to, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'w-naj','w-naj')`, [id, productId, channel, qtyBuy, qtyGetFree, validFrom, validTo]);
}
addPromo('pr-coke-12', 'p-coke', null,         12, 1, '2026-01-01', null);
addPromo('pr-coke-24', 'p-coke', null,         24, 3, '2026-01-01', null);
addPromo('pr-coke-route', 'p-coke', 'ROUTE',    6, 1, '2026-01-01', null);
addPromo('pr-pepsi',  'p-pepsi', null,         10, 1, '2026-01-01', null);

// findBestPromo: re-implement inline
function findBestPromo(productId, channel, atDate, regularQty) {
  return db.all(`
    SELECT id, qty_buy AS qtyBuy, qty_get_free AS qtyGetFree
      FROM promotions
     WHERE product_id = ?
       AND active = 1
       AND valid_from <= ?
       AND (valid_to IS NULL OR valid_to >= ?)
       AND (channel IS NULL OR channel = ?)
       AND qty_buy <= ?
     ORDER BY qty_buy DESC
     LIMIT 1`,
    [productId, atDate, atDate, channel, regularQty])[0];
}

const today = '2026-05-12';

// 12 crates of coke, WALK_IN: should match the 12-buy (not the route-only, since channel doesn't match)
const c12 = findBestPromo('p-coke', 'WALK_IN', today, 12);
check('12 coke → matches 12-buy promo', c12 && c12.qtyBuy === 12);

// 18 crates of coke: greedy on largest qty_buy that fits (12). Multiplier = floor(18/12) = 1.
const c18 = findBestPromo('p-coke', 'WALK_IN', today, 18);
const c18mult = Math.floor(18 / c18.qtyBuy);
check('18 coke picks 12-buy threshold (greedy on largest that fits)', c18.qtyBuy === 12);
check('18 coke multiplier = 1', c18mult === 1);

// 24 crates of coke: largest that fits is 24-buy with 3 free.
const c24 = findBestPromo('p-coke', 'WALK_IN', today, 24);
check('24 coke picks the 24-buy (3 free) over the 12-buy', c24.qtyBuy === 24 && c24.qtyGetFree === 3);

// 36 crates of coke: still picks 24-buy (largest <= 36), multiplier = 1 (floor(36/24)=1)
const c36 = findBestPromo('p-coke', 'WALK_IN', today, 36);
const c36mult = Math.floor(36 / c36.qtyBuy);
check('36 coke picks 24-buy', c36.qtyBuy === 24);
check('36 coke multiplier = 1 (24-buy fires once)', c36mult === 1);

// 48 crates: 24-buy fires twice
const c48 = findBestPromo('p-coke', 'WALK_IN', today, 48);
const c48mult = Math.floor(48 / c48.qtyBuy);
check('48 coke multiplier = 2 (24-buy fires twice → 6 free)', c48mult === 2);

// 6 crates of coke on ROUTE: matches the route-only 6-buy.
const c6route = findBestPromo('p-coke', 'ROUTE', today, 6);
check('6 coke on ROUTE matches the route-only 6-buy', c6route && c6route.qtyBuy === 6);

// 6 crates of coke on WALK_IN: no match (only the route-only 6-buy and the 12-buy/24-buy exist; 6 < 12).
const c6walkin = findBestPromo('p-coke', 'WALK_IN', today, 6);
check('6 coke on WALK_IN finds nothing (channel-scoped 6 not matching, 12 too big)', !c6walkin);

// Pepsi promo doesn't leak into coke.
const c10pepsi = findBestPromo('p-pepsi', 'WALK_IN', today, 10);
check('10 pepsi matches the pepsi 10-buy', c10pepsi && c10pepsi.qtyBuy === 10);
const c10coke = findBestPromo('p-coke', 'WALK_IN', today, 10);
check('10 coke finds nothing (no coke promo with qty_buy <= 10)', !c10coke);

// Validity window: promo with valid_to in the past doesn't match.
addPromo('pr-expired', 'p-coke', null, 6, 1, '2025-01-01', '2025-12-31');
const cExpired = findBestPromo('p-coke', 'WALK_IN', today, 12);
check('expired promo is excluded (12-buy still wins, not the 6-buy from 2025)',
  cExpired && cExpired.id === 'pr-coke-12');

// Archive: inactive promo doesn't match.
db.run(`UPDATE promotions SET active = 0 WHERE id = 'pr-coke-24'`);
const cAfterArchive = findBestPromo('p-coke', 'WALK_IN', today, 24);
check('archived promo excluded (24-buy archived, falls back to 12-buy)',
  cAfterArchive && cAfterArchive.qtyBuy === 12);
db.run(`UPDATE promotions SET active = 1 WHERE id = 'pr-coke-24'`);

// Margin math sanity: 12 crates of coke with 12-buy/1-free at cost 500 each →
// bonus quantity = 1, bonus margin = -(500 * 1) = -500.
const cost = db.all(`SELECT cost_price_pesewas AS c FROM products WHERE id = 'p-coke'`)[0].c;
const bonusQty = 1;
const margin = -(cost * bonusQty);
check('bonus margin = -(cost × qty)', margin === -500);

// CRUD: archive twice rejected at service level (we don't have the service here,
// but the SQL UPDATE itself doesn't enforce that — service code does. Just
// verify the active flag flips.)
db.run(`UPDATE promotions SET active = 0 WHERE id = 'pr-coke-12'`);
check('archive flips active to 0',
  db.all(`SELECT active FROM promotions WHERE id = 'pr-coke-12'`)[0].active === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
