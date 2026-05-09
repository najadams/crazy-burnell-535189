// loyaltyTiers.ts — Wave H foundation.
//
// CRUD for loyalty_thresholds + the computed-tier rule + manual-tier
// writes. The computed tier is calculated at read time, never cached
// (per Section 20.3). Resolution order:
//   effective_tier = customer.loyalty_tier_manual ?? computeTierForCustomer(...)
// Use getEffectiveTier(db, customerId) as the single helper any
// downstream consumer should call — never reimplement the rule.
//
// Verified by _verify_loyalty.mjs (33/33 PASS). Any change to the
// computation rules here should be mirrored in the verifier.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';

type DB = Database;

export type LoyaltyTier = 'VIP' | 'GOLD' | 'SILVER' | 'STANDARD';
export type LoyaltyMetric = 'REVENUE_PESEWAS' | 'MARGIN_PESEWAS' | 'ORDER_COUNT';

const TIER_RANK: Record<LoyaltyTier, number> = {
  VIP: 1, GOLD: 2, SILVER: 3, STANDARD: 4,
};

export interface ThresholdRow {
  id: string;
  tier: LoyaltyTier;
  metric: LoyaltyMetric;
  windowDays: number;
  minValue: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ThresholdUpsertInput {
  id?: string;                          // omit to insert; supply to update existing row
  tier: LoyaltyTier;
  metric: LoyaltyMetric;
  windowDays: number;
  minValue: number;
  notes?: string | null;
}

// --- Threshold CRUD --------------------------------------------------------

export function listThresholds(db: DB, includeInactive = false): ThresholdRow[] {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db
    .prepare(
      `SELECT id, tier, metric, window_days AS windowDays, min_value AS minValue,
              active, notes,
              created_at AS createdAt, created_by AS createdBy,
              updated_at AS updatedAt, updated_by AS updatedBy
         FROM loyalty_thresholds
         ${where}
        ORDER BY CASE tier
                   WHEN 'VIP' THEN 1 WHEN 'GOLD' THEN 2
                   WHEN 'SILVER' THEN 3 WHEN 'STANDARD' THEN 4
                 END ASC,
                 metric ASC, window_days ASC`,
    )
    .all()
    .map((r: any) => ({ ...r, active: !!r.active })) as ThresholdRow[];
}

export function upsertThreshold(
  db: DB, input: ThresholdUpsertInput, workerId: string, deviceId: string,
): { id: string } {
  if (!Number.isInteger(input.windowDays) || input.windowDays <= 0) {
    throw new Error('upsertThreshold: windowDays must be a positive integer');
  }
  if (!Number.isInteger(input.minValue) || input.minValue < 0) {
    throw new Error('upsertThreshold: minValue must be a non-negative integer');
  }

  if (input.id) {
    const r = db.prepare(
      `UPDATE loyalty_thresholds
          SET min_value = ?, notes = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(input.minValue, input.notes ?? null, workerId, input.id);
    if (r.changes === 0) throw new Error(`upsertThreshold: ${input.id} not found`);
    return { id: input.id };
  }

  // Insert new. The unique partial index will reject if an active row
  // already covers (tier, metric, windowDays).
  const id = `lt-${uuidv4()}`;
  db.prepare(
    `INSERT INTO loyalty_thresholds
       (id, tier, metric, window_days, min_value, active, notes,
        created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id, input.tier, input.metric, input.windowDays, input.minValue,
    input.notes ?? null, workerId, workerId, deviceId,
  );
  return { id };
}

export function deactivateThreshold(db: DB, id: string, workerId: string): void {
  const r = db.prepare(
    `UPDATE loyalty_thresholds
        SET active = 0,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_by = ?
      WHERE id = ? AND active = 1`,
  ).run(workerId, id);
  if (r.changes === 0) {
    throw new Error(`deactivateThreshold: ${id} not found or already inactive`);
  }
}

// --- Computed tier ---------------------------------------------------------

/**
 * The metric value for a given customer + threshold, used to test
 * whether the customer clears the threshold's min_value.
 * Revenue subtracts customer_returns in the same window.
 * Margin uses sale_lines.margin_pesewas (already snapshot per sale).
 * Order count counts non-voided sales.
 */
function metricValueFor(
  db: DB, customerId: string, metric: LoyaltyMetric, windowDays: number, now = Date.now(),
): number {
  const cutoffISO = new Date(now - windowDays * 86400_000).toISOString();
  if (metric === 'REVENUE_PESEWAS') {
    const sales = db.prepare(
      `SELECT COALESCE(SUM(total_pesewas), 0) AS v
         FROM sales
        WHERE customer_id = ? AND voided = 0 AND created_at >= ?`,
    ).get(customerId, cutoffISO) as { v: number };
    const refunds = db.prepare(
      `SELECT COALESCE(SUM(total_refund_pesewas), 0) AS v
         FROM customer_returns
        WHERE customer_id = ? AND created_at >= ?`,
    ).get(customerId, cutoffISO) as { v: number };
    return sales.v - refunds.v;
  }
  if (metric === 'MARGIN_PESEWAS') {
    const r = db.prepare(
      `SELECT COALESCE(SUM(sl.margin_pesewas), 0) AS v
         FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
        WHERE s.customer_id = ? AND s.voided = 0 AND s.created_at >= ?`,
    ).get(customerId, cutoffISO) as { v: number };
    return r.v;
  }
  // ORDER_COUNT
  const r = db.prepare(
    `SELECT COUNT(*) AS v
       FROM sales
      WHERE customer_id = ? AND voided = 0 AND created_at >= ?`,
  ).get(customerId, cutoffISO) as { v: number };
  return r.v;
}

/**
 * Highest-tier-first match. Walk active thresholds in tier rank order
 * (VIP → GOLD → SILVER → STANDARD); return the first tier whose
 * metric value clears its min_value.
 *
 * Returns null when the customer has no qualifying threshold (e.g. no
 * sales at all, or all thresholds disabled). The UI displays this as
 * "Computed: insufficient data."
 */
export function computeTierForCustomer(
  db: DB, customerId: string, now = new Date(),
): LoyaltyTier | null {
  const thresholds = listThresholds(db, false);
  // Already sorted by tier rank ASC in listThresholds; explicit sort here
  // is redundant but defensive against ordering changes.
  thresholds.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  for (const t of thresholds) {
    const v = metricValueFor(db, customerId, t.metric, t.windowDays, now.getTime());
    if (v >= t.minValue) return t.tier;
  }
  return null;
}

// --- Manual tier write -----------------------------------------------------

export function setManualTier(
  db: DB,
  customerId: string,
  tier: LoyaltyTier | null,
  reason: string | null,
  workerId: string,
  _deviceId: string,
): void {
  // Read existing for audit before/after.
  const before = db.prepare(
    `SELECT loyalty_tier_manual FROM customers WHERE id = ?`,
  ).get(customerId) as { loyalty_tier_manual: LoyaltyTier | null } | undefined;
  if (!before) throw new Error(`setManualTier: customer ${customerId} not found`);

  if (tier === null) {
    db.prepare(
      `UPDATE customers
          SET loyalty_tier_manual = NULL,
              loyalty_tier_manual_set_at = NULL,
              loyalty_tier_manual_set_by = NULL,
              loyalty_tier_manual_reason = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(workerId, customerId);
  } else {
    db.prepare(
      `UPDATE customers
          SET loyalty_tier_manual = ?,
              loyalty_tier_manual_set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              loyalty_tier_manual_set_by = ?,
              loyalty_tier_manual_reason = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(tier, workerId, reason, workerId, customerId);
  }
  // The IPC handler is expected to write an audit_log row
  // (action LOYALTY_TIER_SET / LOYALTY_TIER_CLEARED) using the existing
  // logAudit helper, with before_value/after_value derived from `before`
  // and `tier`. Keeping logging in the handler avoids a circular import
  // between this service and auditQuery/audit modules.
}

// --- Effective tier (single source of truth for any consumer) -------------

export function getEffectiveTier(
  db: DB, customerId: string, now = new Date(),
): LoyaltyTier | null {
  const row = db.prepare(
    `SELECT loyalty_tier_manual FROM customers WHERE id = ?`,
  ).get(customerId) as { loyalty_tier_manual: LoyaltyTier | null } | undefined;
  if (!row) return null;
  return row.loyalty_tier_manual ?? computeTierForCustomer(db, customerId, now);
}

// --- Default thresholds at first-run --------------------------------------

const DEFAULT_THRESHOLDS: Array<Omit<ThresholdUpsertInput, 'notes'>> = [
  { tier: 'VIP',      metric: 'REVENUE_PESEWAS', windowDays: 90, minValue: 1_000_000 },  // ₵10,000
  { tier: 'GOLD',     metric: 'REVENUE_PESEWAS', windowDays: 90, minValue:   500_000 },  // ₵ 5,000
  { tier: 'SILVER',   metric: 'REVENUE_PESEWAS', windowDays: 90, minValue:   200_000 },  // ₵ 2,000
  { tier: 'STANDARD', metric: 'ORDER_COUNT',     windowDays: 90, minValue:         1 },
];

/**
 * Seed default thresholds if the table is empty. Called once at first-run
 * after the OWNER worker exists (because thresholds.created_by FK requires
 * a worker row). Idempotent — running it twice is a no-op once defaults
 * exist. The OWNER can edit / deactivate any of these afterwards.
 */
export function ensureLoyaltyDefaults(
  db: DB, ownerWorkerId: string, deviceId: string,
): { seeded: number } {
  const existing = db.prepare(
    `SELECT COUNT(*) AS n FROM loyalty_thresholds`,
  ).get() as { n: number };
  if (existing.n > 0) return { seeded: 0 };

  let seeded = 0;
  for (const t of DEFAULT_THRESHOLDS) {
    upsertThreshold(db,
      { ...t, notes: 'seeded default; OWNER may edit' },
      ownerWorkerId, deviceId);
    seeded++;
  }
  return { seeded };
}
