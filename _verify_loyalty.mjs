// Wave H verification target — written BEFORE the service code.
//
// Asserts the migration 0033 schema, the unique partial index, the
// computed-tier highest-match rule, manual ?? computed resolution, the
// cadence ACTIVE/SLIPPING/DORMANT/NEW bucketing, revenue aggregation
// over a window with voided + bonus + refund handling.
//
// Self-contained: builds the minimal schema it needs, applies 0033's
// ALTERs/CREATEs verbatim, and re-implements the read-time logic in JS
// at the same SQL surface the service should use. When the real service
// (customerScorecard.ts / loyaltyTiers.ts / customerLeaderboard.ts) lands,
// it should make every assertion in this file pass against the production
// migration set.
//
// Self-containment matters because Wave G migrations (0029-0032) may not
// be applied yet — Section 20.2 says Wave H is independent of Wave G.

import pkg from 'node-sqlite3-wasm';
import fs from 'node:fs';
import path from 'node:path';
const { Database } = pkg;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

const db = new Database(':memory:');

// ---------- minimal prior schema ---------------------------------------
// Just the columns the loyalty queries touch. Keep this in sync with the
// real migrations 0001-0028 if anything used here gets renamed.
db.exec(`
  CREATE TABLE workers (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL,
    role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE customers (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, phone TEXT NOT NULL,
    customer_type TEXT NOT NULL, credit_limit_pesewas INTEGER NOT NULL DEFAULT 0,
    current_balance_pesewas INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT
  );
  CREATE TABLE products (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cost_price_pesewas INTEGER NOT NULL
  );
  CREATE TABLE sales (
    id TEXT PRIMARY KEY, customer_id TEXT, channel TEXT,
    subtotal_pesewas INTEGER NOT NULL, total_pesewas INTEGER NOT NULL,
    is_credit INTEGER NOT NULL DEFAULT 0, voided INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sale_lines (
    id TEXT PRIMARY KEY, sale_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_pesewas INTEGER NOT NULL,
    unit_cost_pesewas INTEGER NOT NULL,
    line_total_pesewas INTEGER NOT NULL,
    margin_pesewas INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'REGULAR'
  );
  CREATE TABLE customer_returns (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
    refund_method TEXT NOT NULL,
    total_refund_pesewas INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// ---------- apply migration 0033 verbatim ------------------------------
const migPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'migrations',
  '0033_loyalty.sql',
);
db.exec(fs.readFileSync(migPath, 'utf8'));
check('migration 0033 applies cleanly', true);

// ---------- schema assertions ------------------------------------------
const custCols = db.all(`PRAGMA table_info(customers)`).map((r) => r.name);
check('customers.loyalty_tier_manual added', custCols.includes('loyalty_tier_manual'));
check('customers.loyalty_tier_manual_set_at added', custCols.includes('loyalty_tier_manual_set_at'));
check('customers.loyalty_tier_manual_set_by added', custCols.includes('loyalty_tier_manual_set_by'));
check('customers.loyalty_tier_manual_reason added', custCols.includes('loyalty_tier_manual_reason'));

const thrCols = db.all(`PRAGMA table_info(loyalty_thresholds)`).map((r) => r.name);
for (const c of ['tier', 'metric', 'window_days', 'min_value', 'active']) {
  check(`loyalty_thresholds.${c} exists`, thrCols.includes(c));
}

// ---------- fixtures ---------------------------------------------------
const W = 'w-naj';
db.run(`INSERT INTO workers (id, full_name, role) VALUES (?, 'Naj', 'OWNER')`, [W]);
db.run(`INSERT INTO customers (id, display_name, phone, customer_type) VALUES ('c1', 'Mama Akua', '+233244111222', 'WHOLESALE')`);
db.run(`INSERT INTO customers (id, display_name, phone, customer_type) VALUES ('c2', 'Bro Kojo', '+233244111333', 'WHOLESALE')`);
db.run(`INSERT INTO products (id, name, cost_price_pesewas) VALUES ('p-coke', 'Coke 1.5L', 500)`);

// ---------- CHECK-constraint assertions --------------------------------
function rejects(name, sql, params = []) {
  let rejected = false;
  try { db.run(sql, params); } catch { rejected = true; }
  check(name, rejected);
}

rejects(
  'invalid loyalty_tier_manual ("PLATINUM") rejected',
  `UPDATE customers SET loyalty_tier_manual = 'PLATINUM' WHERE id = 'c1'`,
);
rejects(
  'invalid metric ("BANANA_COUNT") rejected',
  `INSERT INTO loyalty_thresholds (id, tier, metric, window_days, min_value, created_by, updated_by, device_id) VALUES ('lt-bad', 'VIP', 'BANANA_COUNT', 90, 1, ?, ?, 'd')`,
  [W, W],
);
rejects(
  'window_days = 0 rejected',
  `INSERT INTO loyalty_thresholds (id, tier, metric, window_days, min_value, created_by, updated_by, device_id) VALUES ('lt-zero', 'VIP', 'REVENUE_PESEWAS', 0, 1, ?, ?, 'd')`,
  [W, W],
);
rejects(
  'min_value < 0 rejected',
  `INSERT INTO loyalty_thresholds (id, tier, metric, window_days, min_value, created_by, updated_by, device_id) VALUES ('lt-neg', 'VIP', 'REVENUE_PESEWAS', 90, -1, ?, ?, 'd')`,
  [W, W],
);

// Valid manual tier accepted
db.run(`UPDATE customers SET loyalty_tier_manual = 'VIP' WHERE id = 'c1'`);
const ttt = db.all(`SELECT loyalty_tier_manual FROM customers WHERE id = 'c1'`)[0];
check('valid manual tier "VIP" accepted', ttt.loyalty_tier_manual === 'VIP');

// ---------- thresholds + uniqueness ------------------------------------
db.run(`INSERT INTO loyalty_thresholds (id, tier, metric, window_days, min_value, active, created_by, updated_by, device_id)
        VALUES ('lt-vip',    'VIP',      'REVENUE_PESEWAS', 90, 1000000, 1, ?, ?, 'd')`, [W, W]);
db.run(`INSERT INTO loyalty_thresholds (id, tier, metric, window_days, min_value, active, created_by, updated_by, device_id)
        VALUES ('lt-gold',   'GOLD',     'REVENUE_PESEWAS', 90,  500000, 1, ?, ?, 'd')`, [W, W]);
db.run(`INSERT INTO loyalty_thresholds (id, tier, metric, window_days, min_value, active, created_by, updated_by, device_id)
        VALUES ('lt-silver', 'SILVER',   'REVENUE_PESEWAS', 90,  200000, 1, ?, ?, 'd')`, [W, W]);
db.run(`INSERT INTO loyalty_thresholds (id, tier, metric, window_days, min_value, active, created_by, updated_by, device_id)
        VALUES ('lt-std',    'STANDARD', 'ORDER_COUNT',     90,       1, 1, ?, ?, 'd')`, [W, W]);

rejects(
  'duplicate active (VIP, REVENUE_PESEWAS, 90) rejected',
  `INSERT INTO loyalty_thresholds (id, tier, metric, window_days, min_value, active, created_by, updated_by, device_id)
   VALUES ('lt-vip-dup', 'VIP', 'REVENUE_PESEWAS', 90, 999, 1, ?, ?, 'd')`,
  [W, W],
);

// Deactivated duplicate is allowed (historic audit)
db.run(`INSERT INTO loyalty_thresholds (id, tier, metric, window_days, min_value, active, created_by, updated_by, device_id)
        VALUES ('lt-vip-old', 'VIP', 'REVENUE_PESEWAS', 90, 999, 0, ?, ?, 'd')`, [W, W]);
const dupCount = db.all(
  `SELECT COUNT(*) AS n FROM loyalty_thresholds WHERE tier='VIP' AND metric='REVENUE_PESEWAS' AND window_days=90`,
)[0].n;
check('historic deactivated duplicate stays in table', dupCount === 2);

// ---------- computed-tier logic (re-implemented in JS) -----------------
const TIER_RANK = { VIP: 1, GOLD: 2, SILVER: 3, STANDARD: 4 };

function computeTier(customerId, now = Date.now()) {
  const thresholds = db.all(
    `SELECT tier, metric, window_days, min_value FROM loyalty_thresholds WHERE active = 1`,
  );
  thresholds.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  for (const t of thresholds) {
    const cutoffISO = new Date(now - t.window_days * 86400_000).toISOString();
    let value = 0;
    if (t.metric === 'REVENUE_PESEWAS') {
      value = db.all(
        `SELECT COALESCE(SUM(total_pesewas), 0) AS v FROM sales
          WHERE customer_id = ? AND voided = 0 AND created_at >= ?`,
        [customerId, cutoffISO],
      )[0].v;
      // Subtract refunds in the window.
      const refunds = db.all(
        `SELECT COALESCE(SUM(total_refund_pesewas), 0) AS v FROM customer_returns
          WHERE customer_id = ? AND created_at >= ?`,
        [customerId, cutoffISO],
      )[0].v;
      value -= refunds;
    } else if (t.metric === 'MARGIN_PESEWAS') {
      value = db.all(
        `SELECT COALESCE(SUM(sl.margin_pesewas), 0) AS v
           FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
          WHERE s.customer_id = ? AND s.voided = 0 AND s.created_at >= ?`,
        [customerId, cutoffISO],
      )[0].v;
    } else if (t.metric === 'ORDER_COUNT') {
      value = db.all(
        `SELECT COUNT(*) AS v FROM sales
          WHERE customer_id = ? AND voided = 0 AND created_at >= ?`,
        [customerId, cutoffISO],
      )[0].v;
    }
    if (value >= t.min_value) return t.tier;
  }
  return null;
}

function getEffectiveTier(customerId) {
  const row = db.all(`SELECT loyalty_tier_manual FROM customers WHERE id = ?`, [customerId])[0];
  return row.loyalty_tier_manual ?? computeTier(customerId);
}

function makeSale(saleId, customerId, totalPesewas, daysAgo, opts = {}) {
  const iso = new Date(Date.now() - daysAgo * 86400_000).toISOString();
  db.run(
    `INSERT INTO sales (id, customer_id, channel, subtotal_pesewas, total_pesewas,
                        is_credit, voided, created_at)
     VALUES (?, ?, 'WHOLESALE', ?, ?, 0, ?, ?)`,
    [saleId, customerId, totalPesewas, totalPesewas, opts.voided ? 1 : 0, iso],
  );
  // Line: REGULAR with margin = (price - cost) * qty
  db.run(
    `INSERT INTO sale_lines (id, sale_id, product_id, quantity,
                             unit_price_pesewas, unit_cost_pesewas,
                             line_total_pesewas, margin_pesewas, kind)
     VALUES (?, ?, 'p-coke', 1, ?, 500, ?, ?, 'REGULAR')`,
    [`sl-${saleId}`, saleId, totalPesewas, totalPesewas, totalPesewas - 500],
  );
  return saleId;
}

// c1: 200,000 + 300,000 = 500,000 pesewas in last 90 days → GOLD (≥500,000)
makeSale('s1', 'c1', 200000, 30);
makeSale('s2', 'c1', 300000, 60);
// c1 also has an old sale outside the window
makeSale('s-old', 'c1', 100000, 200);

// Clear manual tier on c1 so we test computed
db.run(`UPDATE customers SET loyalty_tier_manual = NULL WHERE id = 'c1'`);

const tierC1 = computeTier('c1');
check('c1 with ₵5,000 in 90d → computed tier = GOLD', tierC1 === 'GOLD', `got ${tierC1}`);

// Bump c1 above VIP threshold (₵10,000)
makeSale('s3', 'c1', 600000, 10);
const tierC1Vip = computeTier('c1');
check('c1 with ₵11,000 in 90d → computed tier = VIP', tierC1Vip === 'VIP', `got ${tierC1Vip}`);

// Highest-match rule: VIP wins when both VIP and GOLD thresholds are met
check('highest-tier-first wins (VIP over GOLD)', tierC1Vip === 'VIP');

// Customer with no qualifying revenue, only one sale → STANDARD (ORDER_COUNT ≥ 1)
makeSale('s4', 'c2', 1000, 5);  // ₵10
const tierC2 = computeTier('c2');
check('c2 with 1 small sale → computed tier = STANDARD', tierC2 === 'STANDARD', `got ${tierC2}`);

// Customer with no sales → null tier
db.run(`INSERT INTO customers (id, display_name, phone, customer_type) VALUES ('c3', 'No Sales', '+233244111444', 'WHOLESALE')`);
const tierC3 = computeTier('c3');
check('c3 with no sales → computed tier = null', tierC3 === null, `got ${tierC3}`);

// ---------- effective tier resolution: manual ?? computed --------------
db.run(`UPDATE customers SET loyalty_tier_manual = 'VIP' WHERE id = 'c2'`);
const effC2 = getEffectiveTier('c2');
check('effective(c2) = manual VIP overrides computed STANDARD', effC2 === 'VIP', `got ${effC2}`);

db.run(`UPDATE customers SET loyalty_tier_manual = NULL WHERE id = 'c2'`);
const effC2Computed = getEffectiveTier('c2');
check('effective(c2) falls back to computed STANDARD when manual cleared',
  effC2Computed === 'STANDARD', `got ${effC2Computed}`);

// ---------- voided sales excluded --------------------------------------
makeSale('s-voided', 'c2', 10000000, 5, { voided: 1 });  // ₵100,000 if it counted
const tierC2AfterVoid = computeTier('c2');
check('voided sales excluded from revenue (c2 stays STANDARD)',
  tierC2AfterVoid === 'STANDARD', `got ${tierC2AfterVoid}`);

// ---------- bonus lines contribute zero revenue, negative margin -------
// Add a sale with a BONUS line: regular line ₵100, bonus line cost ₵50
db.run(
  `INSERT INTO sales (id, customer_id, channel, subtotal_pesewas, total_pesewas,
                      is_credit, voided, created_at)
   VALUES ('s-bonus', 'c2', 'WHOLESALE', 100, 100, 0, 0, ?)`,
  [new Date().toISOString()],
);
db.run(
  `INSERT INTO sale_lines (id, sale_id, product_id, quantity,
                           unit_price_pesewas, unit_cost_pesewas,
                           line_total_pesewas, margin_pesewas, kind)
   VALUES ('sl-bonus-reg', 's-bonus', 'p-coke', 1, 100, 50, 100, 50, 'REGULAR')`,
);
db.run(
  `INSERT INTO sale_lines (id, sale_id, product_id, quantity,
                           unit_price_pesewas, unit_cost_pesewas,
                           line_total_pesewas, margin_pesewas, kind)
   VALUES ('sl-bonus-bon', 's-bonus', 'p-coke', 2, 0, 50, 0, -100, 'BONUS')`,
);
const marginRow = db.all(
  `SELECT COALESCE(SUM(sl.margin_pesewas), 0) AS m
     FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
    WHERE s.id = 's-bonus' AND s.voided = 0`,
)[0];
check('margin SUM includes negative BONUS-line cost',
  marginRow.m === -50, `expected -50, got ${marginRow.m}`);

// ---------- refunds subtracted from revenue ----------------------------
db.run(
  `INSERT INTO customer_returns (id, customer_id, refund_method,
                                 total_refund_pesewas, created_at)
   VALUES ('cr-1', 'c1', 'CREDIT', 100000, ?)`,
  [new Date(Date.now() - 5 * 86400_000).toISOString()],
);
const tierAfterRefund = computeTier('c1');
// c1 had ₵11,000 (1,100,000 pesewas). Refund of 100,000 → 1,000,000 = exactly VIP threshold
check('c1 after ₵1,000 refund still meets VIP threshold (1,000,000 ≥ 1,000,000)',
  tierAfterRefund === 'VIP', `got ${tierAfterRefund}`);

// Bigger refund knocks c1 to GOLD
db.run(
  `INSERT INTO customer_returns (id, customer_id, refund_method,
                                 total_refund_pesewas, created_at)
   VALUES ('cr-2', 'c1', 'CREDIT', 200000, ?)`,
  [new Date(Date.now() - 5 * 86400_000).toISOString()],
);
const tierAfterBigRefund = computeTier('c1');
check('c1 after ₵3,000 total refunds drops to GOLD',
  tierAfterBigRefund === 'GOLD', `got ${tierAfterBigRefund}`);

// ---------- cadence math -----------------------------------------------
function cadence(customerId, now = Date.now()) {
  const sales = db.all(
    `SELECT created_at FROM sales WHERE customer_id = ? AND voided = 0
     ORDER BY created_at ASC`,
    [customerId],
  ).map((r) => new Date(r.created_at).getTime());
  if (sales.length === 0) return { medianGap: null, lastGap: null, state: null };

  const lastGap = (now - sales[sales.length - 1]) / 86400_000;
  if (sales.length < 3) {
    const firstGap = (now - sales[0]) / 86400_000;
    if (firstGap < 30) return { medianGap: null, lastGap, state: 'NEW' };
    return { medianGap: null, lastGap, state: 'DORMANT' };
  }
  const deltas = [];
  for (let i = 1; i < sales.length; i++) deltas.push((sales[i] - sales[i - 1]) / 86400_000);
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const medianGap = deltas.length % 2 === 0
    ? (deltas[mid - 1] + deltas[mid]) / 2
    : deltas[mid];

  let state;
  if (lastGap > 60) state = 'DORMANT';
  else if (lastGap <= 1.5 * medianGap) state = 'ACTIVE';
  else if (lastGap <= 3 * medianGap) state = 'SLIPPING';
  else state = 'DORMANT';
  return { medianGap, lastGap, state };
}

// c1 has sales at 200d, 60d, 30d, 10d ago → deltas roughly 140, 30, 20 days, median 30
const cadC1 = cadence('c1');
// Floating-point timestamp drift is normal; assert approximate equality.
check('c1 cadence median ≈ 30 days', Math.abs(cadC1.medianGap - 30) < 0.01,
  `got median ${cadC1.medianGap}, last ${cadC1.lastGap}`);
check('c1 last gap (10d) ≤ 1.5×median (45d) → ACTIVE',
  cadC1.state === 'ACTIVE', `got ${cadC1.state}`);

// Synthetic weekly customer (median gap 7d), last order 12 days ago → SLIPPING.
// Boundaries: ACTIVE when last ≤ 1.5×median (10.5d); SLIPPING when last
// in (10.5, 21]; DORMANT when last > 21d.
db.run(`INSERT INTO customers (id, display_name, phone, customer_type) VALUES ('c-week', 'Weekly Wendy', '+233244111555', 'WHOLESALE')`);
makeSale('w1', 'c-week', 1000, 35);  // chronological order ascending:
makeSale('w2', 'c-week', 1000, 28);  //   w1 oldest, w5 most recent
makeSale('w3', 'c-week', 1000, 21);  // gaps between consecutive: 7, 7, 7, 2
makeSale('w4', 'c-week', 1000, 14);  // sorted deltas [2,7,7,7] → median 7
makeSale('w5', 'c-week', 1000, 12);  // lastGap = 12d
const cadWeek = cadence('c-week');
check('weekly customer (median 7d), last gap 12d → SLIPPING (12 > 1.5×7=10.5; ≤ 3×7=21)',
  cadWeek.state === 'SLIPPING',
  `median ${cadWeek.medianGap}, last ${cadWeek.lastGap}, state ${cadWeek.state}`);

// New customer with the same cadence but last sale 25d ago → DORMANT.
// Use distinct customer to avoid clobbering w5's chronological order.
db.run(`INSERT INTO customers (id, display_name, phone, customer_type) VALUES ('c-dormant', 'Dormant Dee', '+233244111777', 'WHOLESALE')`);
makeSale('d1', 'c-dormant', 1000, 56);  // gaps: 7, 7, 7, 10 → sorted [7,7,7,10] → median 7
makeSale('d2', 'c-dormant', 1000, 49);
makeSale('d3', 'c-dormant', 1000, 42);
makeSale('d4', 'c-dormant', 1000, 35);
makeSale('d5', 'c-dormant', 1000, 25);  // lastGap 25 > 3×7=21
const cadDormant = cadence('c-dormant');
check('weekly customer with 25d last gap → DORMANT (25 > 3×7=21)',
  cadDormant.state === 'DORMANT',
  `median ${cadDormant.medianGap}, last ${cadDormant.lastGap}, state ${cadDormant.state}`);

// New customer (first sale 10 days ago, only one sale) → NEW
db.run(`INSERT INTO customers (id, display_name, phone, customer_type) VALUES ('c-new', 'Fresh Faye', '+233244111666', 'WHOLESALE')`);
makeSale('n1', 'c-new', 1000, 10);
const cadNew = cadence('c-new');
check('customer with 1 sale within 30 days → NEW',
  cadNew.state === 'NEW', `state ${cadNew.state}`);

// ---------- summary ----------------------------------------------------
db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
