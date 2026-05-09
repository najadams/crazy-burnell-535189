// customerLeaderboard.ts — Wave H ranked-customer view.
//
// Sorts customers by revenue / margin / order count over an owner-chosen
// window. Returns engagement-state badge and effective loyalty tier per
// row so a single screen can answer "who matters most this period and
// who's slipping". Used by the new "Top customers" toggle on
// CustomersScreen (Section 20.7).

import type { Database } from 'better-sqlite3';
import { type LoyaltyTier, getEffectiveTier } from './loyaltyTiers.js';

type DB = Database;
type SaleChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

export interface LeaderboardRequest {
  windowStartISO: string;
  windowEndISO: string;
  metric: 'REVENUE_PESEWAS' | 'MARGIN_PESEWAS' | 'ORDER_COUNT';
  limit?: number;             // default 50
  includeBlocked?: boolean;   // default false
  channel?: SaleChannel;      // optional filter
}

export interface LeaderboardRow {
  customerId: string;
  displayName: string;
  phone: string;
  customerType: string;
  metricValue: number;        // pesewas for REVENUE_PESEWAS / MARGIN_PESEWAS, count for ORDER_COUNT
  orderCount: number;         // always populated for context
  revenuePesewas: number;     // always populated for context
  lastOrderDaysAgo: number | null;
  engagementState: 'NEW' | 'ACTIVE' | 'SLIPPING' | 'DORMANT' | null;
  effectiveTier: LoyaltyTier | null;
  rankInWindow: number;       // 1-indexed
}

/**
 * Aggregate per-customer metrics across the window in a single SQL pass,
 * then layer engagement-state and effective tier on top in JS. The JOIN
 * fans out across sale_lines for the margin metric; the SQL carries the
 * weight, the JS just picks the right column to sort/limit on.
 */
export function topCustomers(
  db: DB, req: LeaderboardRequest, now = new Date(),
): LeaderboardRow[] {
  const limit = req.limit ?? 50;
  const includeBlocked = req.includeBlocked ?? false;

  const channelFilter = req.channel ? `AND s.channel = ?` : '';
  const blockedFilter = includeBlocked ? '' : 'AND c.blocked = 0';

  const params: unknown[] = [
    req.windowStartISO, req.windowEndISO,
    req.windowStartISO, req.windowEndISO,
  ];
  if (req.channel) params.push(req.channel, req.channel);
  // We pass the channel filter twice if used, once for sales aggregation
  // and once for refunds aggregation. Handled below by the prepared SQL.

  // Build the aggregate as a single CTE-style query. SQLite supports CTEs
  // since 3.8; the runtime uses a recent enough version (better-sqlite3 11).
  const sql = `
    WITH
    sales_agg AS (
      SELECT s.customer_id,
             SUM(s.total_pesewas) AS revenue,
             COUNT(*)            AS orderCount,
             MAX(s.created_at)   AS lastSale
        FROM sales s
       WHERE s.voided = 0
         AND s.customer_id IS NOT NULL
         AND s.created_at >= ? AND s.created_at < ?
         ${channelFilter}
       GROUP BY s.customer_id
    ),
    margin_agg AS (
      SELECT s.customer_id,
             SUM(sl.margin_pesewas) AS margin
        FROM sale_lines sl
        JOIN sales s ON s.id = sl.sale_id
       WHERE s.voided = 0
         AND s.customer_id IS NOT NULL
         AND s.created_at >= ? AND s.created_at < ?
         ${channelFilter}
       GROUP BY s.customer_id
    ),
    refund_agg AS (
      SELECT cr.customer_id,
             SUM(cr.total_refund_pesewas) AS refund
        FROM customer_returns cr
       WHERE cr.created_at >= ? AND cr.created_at < ?
       GROUP BY cr.customer_id
    )
    SELECT c.id           AS customerId,
           c.display_name AS displayName,
           c.phone        AS phone,
           c.customer_type AS customerType,
           COALESCE(sa.revenue, 0) - COALESCE(ra.refund, 0) AS revenuePesewas,
           COALESCE(ma.margin, 0)                            AS marginPesewas,
           COALESCE(sa.orderCount, 0)                        AS orderCount,
           sa.lastSale                                       AS lastSale
      FROM customers c
      LEFT JOIN sales_agg  sa ON sa.customer_id = c.id
      LEFT JOIN margin_agg ma ON ma.customer_id = c.id
      LEFT JOIN refund_agg ra ON ra.customer_id = c.id
     WHERE 1 = 1
       ${blockedFilter}
       AND (sa.orderCount > 0 OR ma.margin IS NOT NULL OR ra.refund IS NOT NULL)
  `;

  // Refund CTE doesn't take channel filter — refunds aren't per-channel.
  // So channelFilter expands the params count by 2 only.
  const refundParams = [req.windowStartISO, req.windowEndISO];
  const allParams = req.channel
    ? [req.windowStartISO, req.windowEndISO, req.channel,
       req.windowStartISO, req.windowEndISO, req.channel,
       ...refundParams]
    : [req.windowStartISO, req.windowEndISO,
       req.windowStartISO, req.windowEndISO,
       ...refundParams];

  type Row = {
    customerId: string; displayName: string; phone: string; customerType: string;
    revenuePesewas: number; marginPesewas: number; orderCount: number;
    lastSale: string | null;
  };
  const rows = db.prepare(sql).all(...allParams) as Row[];

  // Sort by chosen metric.
  function metricOf(r: Row): number {
    if (req.metric === 'REVENUE_PESEWAS') return r.revenuePesewas;
    if (req.metric === 'MARGIN_PESEWAS')  return r.marginPesewas;
    return r.orderCount;
  }
  rows.sort((a, b) => metricOf(b) - metricOf(a));

  // Limit + project + decorate with engagement-state and tier.
  const limited = rows.slice(0, limit);
  const out: LeaderboardRow[] = [];
  for (let i = 0; i < limited.length; i++) {
    const r = limited[i]!;
    const lastDays = r.lastSale
      ? (now.getTime() - new Date(r.lastSale).getTime()) / 86400_000
      : null;

    out.push({
      customerId: r.customerId,
      displayName: r.displayName,
      phone: r.phone,
      customerType: r.customerType,
      metricValue: metricOf(r),
      orderCount: r.orderCount,
      revenuePesewas: r.revenuePesewas,
      lastOrderDaysAgo: lastDays,
      engagementState: engagementStateFor(db, r.customerId, lastDays, now),
      effectiveTier: getEffectiveTier(db, r.customerId, now),
      rankInWindow: i + 1,
    });
  }
  return out;
}

/**
 * Per-customer engagement state. Re-runs the cadence math from
 * customerScorecard but in a way that doesn't require fetching the
 * full sale list for the leaderboard pass — uses the lastDays we
 * already have plus a single median-gap query.
 */
function engagementStateFor(
  db: DB, customerId: string, lastOrderDaysAgo: number | null, _now: Date,
): LeaderboardRow['engagementState'] {
  if (lastOrderDaysAgo === null) return null;

  // Need at least 3 sales to compute median; fewer means NEW/DORMANT
  // depending on age. Query the count + first-sale date in one round trip.
  const meta = db.prepare(
    `SELECT COUNT(*) AS n, MIN(created_at) AS firstSale
       FROM sales WHERE customer_id = ? AND voided = 0`,
  ).get(customerId) as { n: number; firstSale: string | null };

  if (meta.n === 0) return null;
  if (meta.n < 3) {
    if (!meta.firstSale) return null;
    const firstDays = (_now.getTime() - new Date(meta.firstSale).getTime()) / 86400_000;
    return firstDays < 30 ? 'NEW' : 'DORMANT';
  }

  // Median gap: pull just the timestamps. For most customers this is
  // a small number of rows; if it grows large, swap for a windowed query.
  const rows = db.prepare(
    `SELECT created_at FROM sales WHERE customer_id = ? AND voided = 0
      ORDER BY created_at ASC`,
  ).all(customerId) as Array<{ created_at: string }>;
  const times = rows.map((r) => new Date(r.created_at).getTime());
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) {
    deltas.push((times[i]! - times[i - 1]!) / 86400_000);
  }
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const medianGap = deltas.length % 2 === 0
    ? (deltas[mid - 1]! + deltas[mid]!) / 2
    : deltas[mid]!;

  if (lastOrderDaysAgo > 60) return 'DORMANT';
  if (lastOrderDaysAgo <= 1.5 * medianGap) return 'ACTIVE';
  if (lastOrderDaysAgo <= 3 * medianGap)   return 'SLIPPING';
  return 'DORMANT';
}
