// customerScorecard.ts — Wave H per-customer performance projection.
//
// One read, one customer, one window. Returns:
//   - revenue / margin / order count / avg order value over the window
//   - the same metrics for the previous equal-length window, with deltas
//   - cadence (median gap, last gap, engagement state)
//   - top SKUs ranked by revenue
//   - manual + computed + effective loyalty tier
//
// The scorecard is computed on demand. No materialised view; SQLite is
// fast enough on a single-shop dataset that caching would just be drift
// risk. Revisit only if a screen visibly stutters (Section 15).
//
// Forensic note (Section 20.10): margin is computed from
// sale_lines.margin_pesewas, snapshotted at sale time. Retroactive cost
// changes do NOT alter historical margin. The UI must communicate this.

import type { Database } from 'better-sqlite3';
import {
  computeTierForCustomer, getEffectiveTier, type LoyaltyTier,
} from './loyaltyTiers.js';

type DB = Database;

export interface ScorecardWindow {
  startISO: string;
  endISO: string;
  days: number;
}

export interface CustomerScorecard {
  customer: {
    id: string;
    displayName: string;
    phone: string;
    customerType: string;
  };
  window: ScorecardWindow;

  revenuePesewas: number;
  marginPesewas: number;
  orderCount: number;
  avgOrderPesewas: number;

  previousWindow: {
    startISO: string;
    endISO: string;
    revenuePesewas: number;
    marginPesewas: number;
    orderCount: number;
  };
  trend: {
    revenueDeltaPct: number | null;   // null if previous window was zero
    marginDeltaPct: number | null;
    orderCountDelta: number;          // absolute, not pct
  };

  cadence: {
    medianDaysBetweenOrders: number | null;
    lastOrderDaysAgo: number | null;
    engagementState: 'NEW' | 'ACTIVE' | 'SLIPPING' | 'DORMANT' | null;
  };

  topSkus: Array<{
    productId: string;
    productName: string;
    quantitySold: number;        // sum across BONUS + REGULAR — see note below
    revenuePesewas: number;      // BONUS lines contribute 0
  }>;

  loyaltyTier: {
    manual: LoyaltyTier | null;
    manualSetAt: string | null;
    manualSetBy: string | null;
    manualSetByName: string | null;
    manualReason: string | null;
    computed: LoyaltyTier | null;
    effective: LoyaltyTier | null;
  };
}

// --- Helpers --------------------------------------------------------------

interface AggRow { revenue: number; margin: number; orderCount: number }

function aggregateWindow(
  db: DB, customerId: string, startISO: string, endISO: string,
): AggRow {
  // Revenue: SUM of sales.total_pesewas minus SUM of customer_returns
  // (per Section 20.10). Voided sales excluded.
  const sales = db.prepare(
    `SELECT COALESCE(SUM(total_pesewas), 0) AS revenue,
            COUNT(*) AS orderCount
       FROM sales
      WHERE customer_id = ? AND voided = 0
        AND created_at >= ? AND created_at < ?`,
  ).get(customerId, startISO, endISO) as { revenue: number; orderCount: number };

  const refunds = db.prepare(
    `SELECT COALESCE(SUM(total_refund_pesewas), 0) AS v
       FROM customer_returns
      WHERE customer_id = ?
        AND created_at >= ? AND created_at < ?`,
  ).get(customerId, startISO, endISO) as { v: number };

  // Margin: SUM of sale_lines.margin_pesewas (already snapshot per line).
  // BONUS lines contribute negative margin (correct — the goods left the
  // shelf at zero revenue and real cost).
  const margin = db.prepare(
    `SELECT COALESCE(SUM(sl.margin_pesewas), 0) AS v
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
      WHERE s.customer_id = ? AND s.voided = 0
        AND s.created_at >= ? AND s.created_at < ?`,
  ).get(customerId, startISO, endISO) as { v: number };

  return {
    revenue: sales.revenue - refunds.v,
    margin: margin.v,
    orderCount: sales.orderCount,
  };
}

function deltaPct(curr: number, prev: number): number | null {
  if (prev === 0) return null;       // can't divide; UI shows "—"
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function computeCadence(
  db: DB, customerId: string, now: Date,
): CustomerScorecard['cadence'] {
  const rows = db.prepare(
    `SELECT created_at FROM sales
      WHERE customer_id = ? AND voided = 0
      ORDER BY created_at ASC`,
  ).all(customerId) as Array<{ created_at: string }>;

  if (rows.length === 0) {
    return { medianDaysBetweenOrders: null, lastOrderDaysAgo: null, engagementState: null };
  }

  const times = rows.map((r) => new Date(r.created_at).getTime());
  const lastOrderDaysAgo = (now.getTime() - times[times.length - 1]!) / 86400_000;

  // Insufficient data: < 3 sales. NEW if first sale within last 30 days,
  // else DORMANT (a customer with one sale a year ago is dormant).
  if (times.length < 3) {
    const firstSaleDaysAgo = (now.getTime() - times[0]!) / 86400_000;
    const state: 'NEW' | 'DORMANT' = firstSaleDaysAgo < 30 ? 'NEW' : 'DORMANT';
    return { medianDaysBetweenOrders: null, lastOrderDaysAgo, engagementState: state };
  }

  // Median delta in days between consecutive orders.
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) {
    deltas.push((times[i]! - times[i - 1]!) / 86400_000);
  }
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const medianGap = deltas.length % 2 === 0
    ? (deltas[mid - 1]! + deltas[mid]!) / 2
    : deltas[mid]!;

  let state: 'ACTIVE' | 'SLIPPING' | 'DORMANT';
  if (lastOrderDaysAgo > 60) state = 'DORMANT';
  else if (lastOrderDaysAgo <= 1.5 * medianGap) state = 'ACTIVE';
  else if (lastOrderDaysAgo <= 3 * medianGap) state = 'SLIPPING';
  else state = 'DORMANT';

  return {
    medianDaysBetweenOrders: medianGap,
    lastOrderDaysAgo,
    engagementState: state,
  };
}

function topSkus(
  db: DB, customerId: string, startISO: string, endISO: string, limit = 5,
): CustomerScorecard['topSkus'] {
  return db.prepare(
    `SELECT p.id AS productId, p.name AS productName,
            SUM(sl.quantity) AS quantitySold,
            SUM(sl.line_total_pesewas) AS revenuePesewas
       FROM sale_lines sl
       JOIN sales s   ON s.id = sl.sale_id
       JOIN products p ON p.id = sl.product_id
      WHERE s.customer_id = ? AND s.voided = 0
        AND s.created_at >= ? AND s.created_at < ?
      GROUP BY p.id, p.name
      ORDER BY revenuePesewas DESC, quantitySold DESC
      LIMIT ?`,
  ).all(customerId, startISO, endISO, limit) as CustomerScorecard['topSkus'];
}

// --- Main entry point -----------------------------------------------------

export function buildCustomerScorecard(
  db: DB,
  customerId: string,
  window: ScorecardWindow,
  now = new Date(),
): CustomerScorecard {
  const cust = db.prepare(
    `SELECT id, display_name AS displayName, phone, customer_type AS customerType,
            loyalty_tier_manual            AS manual,
            loyalty_tier_manual_set_at     AS manualSetAt,
            loyalty_tier_manual_set_by     AS manualSetBy,
            loyalty_tier_manual_reason     AS manualReason
       FROM customers WHERE id = ?`,
  ).get(customerId) as
    | {
        id: string; displayName: string; phone: string; customerType: string;
        manual: LoyaltyTier | null; manualSetAt: string | null;
        manualSetBy: string | null; manualReason: string | null;
      }
    | undefined;
  if (!cust) throw new Error(`buildCustomerScorecard: customer ${customerId} not found`);

  // Resolve manual setter's name for display.
  let manualSetByName: string | null = null;
  if (cust.manualSetBy) {
    const w = db.prepare(`SELECT full_name FROM workers WHERE id = ?`)
      .get(cust.manualSetBy) as { full_name: string } | undefined;
    manualSetByName = w?.full_name ?? null;
  }

  // Current window
  const curr = aggregateWindow(db, customerId, window.startISO, window.endISO);

  // Previous window: same length, immediately preceding.
  const startMs = new Date(window.startISO).getTime();
  const prevEndISO = window.startISO;
  const prevStartISO = new Date(startMs - window.days * 86400_000).toISOString();
  const prev = aggregateWindow(db, customerId, prevStartISO, prevEndISO);

  const computed = computeTierForCustomer(db, customerId, now);
  const effective = cust.manual ?? computed;

  return {
    customer: {
      id: cust.id,
      displayName: cust.displayName,
      phone: cust.phone,
      customerType: cust.customerType,
    },
    window,
    revenuePesewas: curr.revenue,
    marginPesewas: curr.margin,
    orderCount: curr.orderCount,
    avgOrderPesewas: curr.orderCount > 0
      ? Math.round(curr.revenue / curr.orderCount)
      : 0,
    previousWindow: {
      startISO: prevStartISO,
      endISO: prevEndISO,
      revenuePesewas: prev.revenue,
      marginPesewas: prev.margin,
      orderCount: prev.orderCount,
    },
    trend: {
      revenueDeltaPct: deltaPct(curr.revenue, prev.revenue),
      marginDeltaPct:  deltaPct(curr.margin,  prev.margin),
      orderCountDelta: curr.orderCount - prev.orderCount,
    },
    cadence: computeCadence(db, customerId, now),
    topSkus: topSkus(db, customerId, window.startISO, window.endISO, 5),
    loyaltyTier: {
      manual: cust.manual,
      manualSetAt: cust.manualSetAt,
      manualSetBy: cust.manualSetBy,
      manualSetByName,
      manualReason: cust.manualReason,
      computed,
      effective,
    },
  };
}

// --- Convenience builders for the IPC handler -----------------------------

/** Window of last N days ending now. */
export function windowLastNDays(days: number, now = new Date()): ScorecardWindow {
  const end = new Date(now);
  const start = new Date(end.getTime() - days * 86400_000);
  return { startISO: start.toISOString(), endISO: end.toISOString(), days };
}

/** Custom window from explicit ISO bounds. Caller responsible for ordering. */
export function windowFromBounds(startISO: string, endISO: string): ScorecardWindow {
  const days = Math.max(1, Math.round(
    (new Date(endISO).getTime() - new Date(startISO).getTime()) / 86400_000,
  ));
  return { startISO, endISO, days };
}
