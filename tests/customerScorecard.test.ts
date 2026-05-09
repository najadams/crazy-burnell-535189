// customerScorecard.test.ts — Wave H projection-layer assertions.
//
// Section 20.11 names a 12+ assertion target across:
//   - revenue/margin window aggregation matches a hand-computed value
//   - trend % correct for "this 90 vs last 90"
//   - top SKUs ranked by revenue with quantity tiebreak
//   - refunds subtracted from window revenue
//   - bonus lines contribute zero revenue and negative margin
//
// We hit those, plus a few more (voided exclusion, prev-window
// boundaries, null-trend-when-prev-zero, effective tier resolution).
//
// Self-contained pattern mirroring _verify_loyalty.mjs: build the
// minimal columns the projection touches, apply migration 0033
// verbatim, seed deterministic fixtures, then call the production
// service. Keeps the test independent of Wave G's migrations
// (Section 20.2: Wave H is parallel to Wave G core, not dependent
// on it).

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  buildCustomerScorecard, windowFromBounds,
  type ScorecardWindow,
} from '../src/main/services/customerScorecard';

// --- Constants ------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0033 = fs.readFileSync(
  path.resolve(__dirname, '..', 'migrations', '0033_loyalty.sql'),
  'utf8',
);

// Anchor the clock to a specific moment so daysFromNow arithmetic in the
// fixture lines up exactly with the window bounds below. Without this
// anchor the test would drift each day relative to the boundary.
const NOW = new Date('2026-01-31T00:00:00.000Z');
const WINDOW: ScorecardWindow = {
  startISO: '2026-01-01T00:00:00.000Z',
  endISO:   '2026-01-31T00:00:00.000Z',
  days: 30,
};

// --- Schema setup ---------------------------------------------------------

const MINIMAL_SCHEMA = `
  CREATE TABLE workers (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    customer_type TEXT NOT NULL,
    credit_limit_pesewas INTEGER NOT NULL DEFAULT 0,
    current_balance_pesewas INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    blocked_reason TEXT,
    -- Audit columns the production setManualTier writes; supplied so
    -- direct UPDATEs in the fixture work the same shape.
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT
  );

  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cost_price_pesewas INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sales (
    id TEXT PRIMARY KEY,
    customer_id TEXT,
    channel TEXT,
    subtotal_pesewas INTEGER NOT NULL,
    total_pesewas INTEGER NOT NULL,
    is_credit INTEGER NOT NULL DEFAULT 0,
    voided INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sale_lines (
    id TEXT PRIMARY KEY,
    sale_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_pesewas INTEGER NOT NULL,
    unit_cost_pesewas INTEGER NOT NULL,
    line_total_pesewas INTEGER NOT NULL,
    margin_pesewas INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'REGULAR'
  );

  CREATE TABLE customer_returns (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    refund_method TEXT NOT NULL,
    total_refund_pesewas INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`;

const W_OWNER = 'w-owner-1';
const W_DEVICE = 'd-test';
const C_A = 'cust-a';
const P_X = 'p-x';   // Coke
const P_Y = 'p-y';   // Sprite
const P_Z = 'p-z';   // Fanta

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MINIMAL_SCHEMA);
  db.exec(MIGRATION_0033);

  // Common seed: one OWNER worker, one customer, three products. Tests
  // can layer additional sales/returns on top.
  db.prepare(
    `INSERT INTO workers (id, full_name, role) VALUES (?, ?, ?)`,
  ).run(W_OWNER, 'Naj', 'OWNER');

  db.prepare(
    `INSERT INTO customers (id, display_name, phone, customer_type)
     VALUES (?, ?, ?, ?)`,
  ).run(C_A, 'Mama Akua', '+233244111222', 'WHOLESALE');

  db.prepare(
    `INSERT INTO products (id, name, cost_price_pesewas) VALUES (?, ?, ?)`,
  ).run(P_X, 'Coke 1.5L', 1000);
  db.prepare(
    `INSERT INTO products (id, name, cost_price_pesewas) VALUES (?, ?, ?)`,
  ).run(P_Y, 'Sprite 1.5L', 500);
  db.prepare(
    `INSERT INTO products (id, name, cost_price_pesewas) VALUES (?, ?, ?)`,
  ).run(P_Z, 'Fanta 1.5L', 800);

  return db;
}

// --- Fixture helpers ------------------------------------------------------

interface LineSpec {
  id: string;
  productId: string;
  qty: number;
  unitPrice: number;        // pesewas
  unitCost: number;         // pesewas
  kind?: 'REGULAR' | 'BONUS';
}

interface SaleSpec {
  id: string;
  daysFromNow: number;       // positive = days BEFORE NOW
  voided?: boolean;
  lines: LineSpec[];
}

function isoDaysAgo(days: number, now: Date = NOW): string {
  return new Date(now.getTime() - days * 86400_000).toISOString();
}

function insertSale(db: Database.Database, customerId: string, spec: SaleSpec): void {
  const total = spec.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  db.prepare(
    `INSERT INTO sales (id, customer_id, channel, subtotal_pesewas,
                         total_pesewas, is_credit, voided, created_at)
     VALUES (?, ?, 'ROUTE', ?, ?, 0, ?, ?)`,
  ).run(spec.id, customerId, total, total, spec.voided ? 1 : 0,
        isoDaysAgo(spec.daysFromNow));

  for (const l of spec.lines) {
    const lineTotal = l.unitPrice * l.qty;
    const margin = (l.unitPrice - l.unitCost) * l.qty;
    db.prepare(
      `INSERT INTO sale_lines (id, sale_id, product_id, quantity,
                                unit_price_pesewas, unit_cost_pesewas,
                                line_total_pesewas, margin_pesewas, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(l.id, spec.id, l.productId, l.qty, l.unitPrice, l.unitCost,
          lineTotal, margin, l.kind ?? 'REGULAR');
  }
}

function insertRefund(
  db: Database.Database, customerId: string, id: string,
  amount: number, daysFromNow: number,
): void {
  db.prepare(
    `INSERT INTO customer_returns (id, customer_id, refund_method,
                                    total_refund_pesewas, created_at)
     VALUES (?, ?, 'CASH', ?, ?)`,
  ).run(id, customerId, amount, isoDaysAgo(daysFromNow));
}

function insertThreshold(
  db: Database.Database, id: string, tier: string, metric: string,
  windowDays: number, minValue: number,
): void {
  db.prepare(
    `INSERT INTO loyalty_thresholds
        (id, tier, metric, window_days, min_value, active,
         created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(id, tier, metric, windowDays, minValue, W_OWNER, W_OWNER, W_DEVICE);
}

// --- Tests ----------------------------------------------------------------

describe('customerScorecard projection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  // -----------------------------------------------------------------------
  // Window aggregation, voided exclusion, refund subtraction, bonus lines
  // -----------------------------------------------------------------------

  describe('with two in-window sales, two prev-window sales, a voided sale, a refund, and a bonus line', () => {
    beforeEach(() => {
      // In-window sales (2026-01-01 .. 2026-01-31):
      //   s1 (15d ago = 2026-01-16) — total 10,000
      //   s2 (11d ago = 2026-01-20) — total 15,000, includes BONUS line
      // Previous window (2025-12-02 .. 2026-01-01):
      //   s3 (47d ago = 2025-12-15) — total 5,000
      //   s4 (37d ago = 2025-12-25) — total 10,000
      // Voided in-window sale s5 — should be excluded.
      // Out-of-both-windows s6 (143d ago, 2025-09-10) — only feeds cadence.
      insertSale(db, C_A, {
        id: 's1', daysFromNow: 15, lines: [
          { id: 'sl1', productId: P_X, qty: 2, unitPrice: 4000, unitCost: 1000 },
          { id: 'sl2', productId: P_Y, qty: 1, unitPrice: 2000, unitCost: 500 },
        ],
      });
      insertSale(db, C_A, {
        id: 's2', daysFromNow: 11, lines: [
          { id: 'sl3', productId: P_X, qty: 3, unitPrice: 4000, unitCost: 1000 },
          { id: 'sl4', productId: P_Z, qty: 1, unitPrice: 3000, unitCost: 800 },
          // BONUS: zero revenue, real cost — margin = -1000.
          { id: 'sl5', productId: P_X, qty: 1, unitPrice: 0, unitCost: 1000, kind: 'BONUS' },
        ],
      });
      insertSale(db, C_A, {
        id: 's3', daysFromNow: 47, lines: [
          { id: 'sl6', productId: P_Y, qty: 1, unitPrice: 5000, unitCost: 1000 },
        ],
      });
      insertSale(db, C_A, {
        id: 's4', daysFromNow: 37, lines: [
          { id: 'sl7', productId: P_X, qty: 2, unitPrice: 5000, unitCost: 1000 },
        ],
      });
      insertSale(db, C_A, {
        id: 's5', daysFromNow: 6, voided: true, lines: [
          { id: 'sl8', productId: P_X, qty: 99, unitPrice: 1010, unitCost: 1000 },
        ],
      });
      insertSale(db, C_A, {
        id: 's6', daysFromNow: 143, lines: [
          { id: 'sl9', productId: P_X, qty: 1, unitPrice: 2000, unitCost: 500 },
        ],
      });
      // Refund inside the window (9d ago = 2026-01-22): 2,000 pesewas.
      insertRefund(db, C_A, 'r1', 2000, 9);
    });

    it('aggregates revenue, margin, orderCount, and avgOrder for the current window', () => {
      const sc = buildCustomerScorecard(db, C_A, WINDOW, NOW);

      // Revenue = (s1 + s2 totals) − refund = 10,000 + 15,000 − 2,000 = 23,000
      expect(sc.revenuePesewas).toBe(23_000);

      // Margin = sl1+sl2+sl3+sl4+sl5 = 6,000 + 1,500 + 9,000 + 2,200 − 1,000
      //        = 17,700.  Bonus line drops margin by its real cost.
      expect(sc.marginPesewas).toBe(17_700);

      // Order count is 2 — voided sale s5 excluded.
      expect(sc.orderCount).toBe(2);

      // Avg = round(23,000 / 2) = 11,500.
      expect(sc.avgOrderPesewas).toBe(11_500);
    });

    it('computes previous-window metrics with correct boundaries', () => {
      const sc = buildCustomerScorecard(db, C_A, WINDOW, NOW);

      // Prev: 2025-12-02 (window.start − 30d) .. 2026-01-01 (= window.start).
      expect(sc.previousWindow.startISO).toBe('2025-12-02T00:00:00.000Z');
      expect(sc.previousWindow.endISO).toBe(WINDOW.startISO);

      // Revenue prev window = s3 + s4 = 5,000 + 10,000 = 15,000.
      expect(sc.previousWindow.revenuePesewas).toBe(15_000);

      // Margin prev window = sl6 + sl7 = 4,000 + 8,000 = 12,000.
      expect(sc.previousWindow.marginPesewas).toBe(12_000);

      expect(sc.previousWindow.orderCount).toBe(2);
    });

    it('computes trend % as (curr − prev) / |prev| × 100; orderCountDelta is absolute', () => {
      const sc = buildCustomerScorecard(db, C_A, WINDOW, NOW);

      // (23,000 − 15,000) / 15,000 × 100 = 53.333…
      expect(sc.trend.revenueDeltaPct).toBeCloseTo(53.3333, 2);

      // (17,700 − 12,000) / 12,000 × 100 = 47.5
      expect(sc.trend.marginDeltaPct).toBeCloseTo(47.5, 4);

      // 2 − 2 = 0
      expect(sc.trend.orderCountDelta).toBe(0);
    });

    it('subtracts customer_returns from window revenue (and not from prev where there was no refund)', () => {
      const sc = buildCustomerScorecard(db, C_A, WINDOW, NOW);
      // If refunds were not subtracted, current revenue would be 25,000.
      // We assert the difference is exactly the refund amount.
      const grossRevenue = 10_000 + 15_000;
      expect(grossRevenue - sc.revenuePesewas).toBe(2_000);
      // And prev window had no refunds; assert raw equality.
      expect(sc.previousWindow.revenuePesewas).toBe(15_000);
    });

    it('ranks topSkus by revenue (BONUS contributes 0)', () => {
      const sc = buildCustomerScorecard(db, C_A, WINDOW, NOW);

      // Expected ranking: p-x (sl1+sl3+sl5 = 8000+12000+0 = 20,000),
      //                   p-z (sl4 = 3,000),
      //                   p-y (sl2 = 2,000).
      expect(sc.topSkus.length).toBe(3);
      expect(sc.topSkus[0]!.productId).toBe(P_X);
      expect(sc.topSkus[0]!.revenuePesewas).toBe(20_000);
      // qty includes the BONUS unit (1) — 2+3+1 = 6.
      expect(sc.topSkus[0]!.quantitySold).toBe(6);

      expect(sc.topSkus[1]!.productId).toBe(P_Z);
      expect(sc.topSkus[1]!.revenuePesewas).toBe(3_000);

      expect(sc.topSkus[2]!.productId).toBe(P_Y);
      expect(sc.topSkus[2]!.revenuePesewas).toBe(2_000);
    });

    it('cadence: 5 sales spanning months → engagementState ACTIVE', () => {
      // Sale times relative to NOW (days ago): 143, 47, 37, 15, 11.
      // Deltas (sorted): 4, 10, 22, 96. Median (4 even) = (10+22)/2 = 16.
      // lastGap = 11. 11 ≤ 1.5 × 16 = 24 → ACTIVE.
      const sc = buildCustomerScorecard(db, C_A, WINDOW, NOW);
      expect(sc.cadence.medianDaysBetweenOrders).not.toBeNull();
      expect(sc.cadence.engagementState).toBe('ACTIVE');
      expect(sc.cadence.lastOrderDaysAgo).toBeCloseTo(11, 0);
    });
  });

  // -----------------------------------------------------------------------
  // Top-SKU tiebreak: equal revenue → higher qty wins.
  // -----------------------------------------------------------------------

  it('ranks topSkus by revenue, breaking ties on quantity sold', () => {
    // Two products with identical revenue. Higher quantity should rank
    // first (the SQL ORDER BY revenuePesewas DESC, quantitySold DESC).
    insertSale(db, C_A, {
      id: 't-1', daysFromNow: 10, lines: [
        // p-x: qty 5 × ₵100 = 500 revenue
        { id: 'tl-x', productId: P_X, qty: 5, unitPrice: 100, unitCost: 50 },
        // p-y: qty 1 × ₵500 = 500 revenue (same revenue, fewer units)
        { id: 'tl-y', productId: P_Y, qty: 1, unitPrice: 500, unitCost: 100 },
      ],
    });

    const sc = buildCustomerScorecard(db, C_A, WINDOW, NOW);
    expect(sc.topSkus.length).toBe(2);
    expect(sc.topSkus[0]!.productId).toBe(P_X);     // higher qty wins tie
    expect(sc.topSkus[0]!.revenuePesewas).toBe(500);
    expect(sc.topSkus[1]!.productId).toBe(P_Y);
  });

  // -----------------------------------------------------------------------
  // Trend % is null when previous window had no activity (avoid divide-by-0).
  // -----------------------------------------------------------------------

  it('returns null trend % when the previous window had zero revenue / margin', () => {
    // Only an in-window sale; nothing in prev window.
    insertSale(db, C_A, {
      id: 'only-1', daysFromNow: 5, lines: [
        { id: 'ol-1', productId: P_X, qty: 1, unitPrice: 1000, unitCost: 200 },
      ],
    });

    const sc = buildCustomerScorecard(db, C_A, WINDOW, NOW);
    expect(sc.previousWindow.revenuePesewas).toBe(0);
    expect(sc.previousWindow.marginPesewas).toBe(0);
    expect(sc.trend.revenueDeltaPct).toBeNull();
    expect(sc.trend.marginDeltaPct).toBeNull();
    // But the absolute orderCountDelta is still defined (not null).
    expect(sc.trend.orderCountDelta).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Effective tier resolution: manual ?? computed.
  // -----------------------------------------------------------------------

  it('resolves effective tier as the manual tier when one is set', () => {
    // No sales, no thresholds, but a manual tier — effective = manual.
    db.prepare(
      `UPDATE customers SET loyalty_tier_manual = 'VIP' WHERE id = ?`,
    ).run(C_A);

    const sc = buildCustomerScorecard(db, C_A, WINDOW, NOW);
    expect(sc.loyaltyTier.manual).toBe('VIP');
    expect(sc.loyaltyTier.computed).toBeNull();
    expect(sc.loyaltyTier.effective).toBe('VIP');
  });

  it('resolves effective tier as computed when no manual tier is set', () => {
    // Threshold for GOLD at ₵500 in 90 days; sale of ₵1000 in window.
    // Computed: GOLD wins. Effective: GOLD (no manual override).
    insertThreshold(db, 'lt-vip',  'VIP',  'REVENUE_PESEWAS', 90, 100_000);
    insertThreshold(db, 'lt-gold', 'GOLD', 'REVENUE_PESEWAS', 90, 500);
    insertSale(db, C_A, {
      id: 'qual-1', daysFromNow: 20, lines: [
        { id: 'ql-1', productId: P_X, qty: 1, unitPrice: 1000, unitCost: 200 },
      ],
    });

    const sc = buildCustomerScorecard(db, C_A, WINDOW, NOW);
    expect(sc.loyaltyTier.manual).toBeNull();
    expect(sc.loyaltyTier.computed).toBe('GOLD');
    expect(sc.loyaltyTier.effective).toBe('GOLD');
  });

  // -----------------------------------------------------------------------
  // Sanity check on windowFromBounds — used by the IPC handler.
  // -----------------------------------------------------------------------

  it('windowFromBounds derives days from explicit ISO bounds', () => {
    const w = windowFromBounds('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');
    expect(w.days).toBe(30);
    expect(w.startISO).toBe('2026-01-01T00:00:00.000Z');
    expect(w.endISO).toBe('2026-01-31T00:00:00.000Z');
  });
});
