// Wave H IPC dispatcher additions. Mirror the existing wave-handler-group
// pattern: registerWaveHHandlers(ipcMain, db, deviceId) is called from
// src/main/index.ts alongside the other registerSession*Handlers and
// registerXxxHandlers calls.
//
// Auth model:
//   - Read endpoints (listThresholds, scorecard, leaderboard, previewTier)
//     require any authenticated worker.
//   - Threshold writes and manual-tier writes are OWNER-gated via
//     requireOwnerLike(). The role gate is also surfaced in the UI as a
//     visible-but-disabled button per Section 11.

import {
  IPC_CHANNELS_LOYALTY,
  type LoyaltyListThresholdsRequest, type LoyaltyListThresholdsResponse,
  type LoyaltyUpsertThresholdRequest, type LoyaltyUpsertThresholdResponse,
  type LoyaltyDeactivateThresholdRequest, type LoyaltyDeactivateThresholdResponse,
  type LoyaltyPreviewTierRequest, type LoyaltyPreviewTierResponse,
  type CustomerScorecardRequest, type CustomerScorecardResponse,
  type CustomerLeaderboardRequest, type CustomerLeaderboardResponse,
  type CustomerSetManualTierRequest, type CustomerSetManualTierResponse,
  type CustomerClearManualTierRequest, type CustomerClearManualTierResponse,
} from '../../shared/types/ipc-wave-h.js';
import {
  computeTierForCustomer, deactivateThreshold, getEffectiveTier,
  listThresholds, setManualTier, upsertThreshold,
} from '../services/loyaltyTiers.js';
import {
  buildCustomerScorecard, windowFromBounds, windowLastNDays,
} from '../services/customerScorecard.js';
import { topCustomers } from '../services/customerLeaderboard.js';
import { logAudit } from '../services/auditQuery.js';

// --- Helpers expected to exist in the parent handlers module --------------
// `wrap`, `requireWorker`, `requireOwnerLike` are defined in
// src/main/ipc/handlers.ts. Import them from there in the real codebase;
// for this drop-in file we declare the shapes inline.
type Session = { workerId: string; fullName: string; role: string };
type WrapFn = <Req, Res>(
  fn: (req: Req) => Res | Promise<Res>,
  channel: string,
) => (event: unknown, req: Req) => Promise<{ success: true; data: Res } | { success: false; error: string }>;

interface Helpers {
  wrap: WrapFn;
  requireWorker: () => Session;
  requireOwnerLike: () => Session;
}

export function registerWaveHHandlers(
  ipcMain: import('electron').IpcMain,
  db: import('better-sqlite3').Database,
  deviceId: string,
  helpers: Helpers,
): void {
  const { wrap, requireWorker, requireOwnerLike } = helpers;

  ipcMain.handle(IPC_CHANNELS_LOYALTY.LOYALTY_LIST_THRESHOLDS,
    wrap<LoyaltyListThresholdsRequest, LoyaltyListThresholdsResponse>(
      (req) => {
        requireWorker();
        return { thresholds: listThresholds(db, !!req?.includeInactive) };
      },
      IPC_CHANNELS_LOYALTY.LOYALTY_LIST_THRESHOLDS,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_LOYALTY.LOYALTY_UPSERT_THRESHOLD,
    wrap<LoyaltyUpsertThresholdRequest, LoyaltyUpsertThresholdResponse>(
      (req) => {
        const w = requireOwnerLike();
        const before = req.id
          ? listThresholds(db, true).find((t) => t.id === req.id) ?? null
          : null;
        const r = upsertThreshold(db, req, w.workerId, deviceId);
        logAudit(db, {
          workerId: w.workerId,
          action: req.id ? 'LOYALTY_THRESHOLD_UPDATED' : 'LOYALTY_THRESHOLD_CREATED',
          entityType: 'loyalty_thresholds',
          entityId: r.id,
          beforeValue: before,
          afterValue: req,
          deviceId,
        });
        return r;
      },
      IPC_CHANNELS_LOYALTY.LOYALTY_UPSERT_THRESHOLD,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_LOYALTY.LOYALTY_DEACTIVATE_THRESHOLD,
    wrap<LoyaltyDeactivateThresholdRequest, LoyaltyDeactivateThresholdResponse>(
      (req) => {
        const w = requireOwnerLike();
        deactivateThreshold(db, req.id, w.workerId);
        logAudit(db, {
          workerId: w.workerId,
          action: 'LOYALTY_THRESHOLD_DEACTIVATED',
          entityType: 'loyalty_thresholds',
          entityId: req.id,
          afterValue: { active: false },
          deviceId,
        });
        return { ok: true };
      },
      IPC_CHANNELS_LOYALTY.LOYALTY_DEACTIVATE_THRESHOLD,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_LOYALTY.LOYALTY_PREVIEW_TIER,
    wrap<LoyaltyPreviewTierRequest, LoyaltyPreviewTierResponse>(
      (req) => {
        requireWorker();
        const computed = computeTierForCustomer(db, req.customerId);
        const effective = getEffectiveTier(db, req.customerId);
        const row = db.prepare(
          `SELECT loyalty_tier_manual AS manual FROM customers WHERE id = ?`,
        ).get(req.customerId) as { manual: typeof computed } | undefined;
        return { computed, effective, manual: row?.manual ?? null };
      },
      IPC_CHANNELS_LOYALTY.LOYALTY_PREVIEW_TIER,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_LOYALTY.CUSTOMER_SCORECARD,
    wrap<CustomerScorecardRequest, CustomerScorecardResponse>(
      (req) => {
        requireWorker();
        const window = req.windowStartISO && req.windowEndISO
          ? windowFromBounds(req.windowStartISO, req.windowEndISO)
          : windowLastNDays(req.windowDays ?? 90);
        return { scorecard: buildCustomerScorecard(db, req.customerId, window) };
      },
      IPC_CHANNELS_LOYALTY.CUSTOMER_SCORECARD,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_LOYALTY.CUSTOMER_LEADERBOARD,
    wrap<CustomerLeaderboardRequest, CustomerLeaderboardResponse>(
      (req) => {
        requireWorker();
        return { rows: topCustomers(db, req) };
      },
      IPC_CHANNELS_LOYALTY.CUSTOMER_LEADERBOARD,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_LOYALTY.CUSTOMER_SET_MANUAL_TIER,
    wrap<CustomerSetManualTierRequest, CustomerSetManualTierResponse>(
      (req) => {
        const w = requireOwnerLike();
        const before = db.prepare(
          `SELECT loyalty_tier_manual, loyalty_tier_manual_reason FROM customers WHERE id = ?`,
        ).get(req.customerId);
        setManualTier(db, req.customerId, req.tier, req.reason ?? null, w.workerId, deviceId);
        logAudit(db, {
          workerId: w.workerId,
          action: 'LOYALTY_TIER_SET',
          entityType: 'customers',
          entityId: req.customerId,
          beforeValue: before,
          afterValue: { tier: req.tier, reason: req.reason ?? null },
          deviceId,
        });
        return { ok: true };
      },
      IPC_CHANNELS_LOYALTY.CUSTOMER_SET_MANUAL_TIER,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_LOYALTY.CUSTOMER_CLEAR_MANUAL_TIER,
    wrap<CustomerClearManualTierRequest, CustomerClearManualTierResponse>(
      (req) => {
        const w = requireOwnerLike();
        const before = db.prepare(
          `SELECT loyalty_tier_manual, loyalty_tier_manual_reason FROM customers WHERE id = ?`,
        ).get(req.customerId);
        setManualTier(db, req.customerId, null, null, w.workerId, deviceId);
        logAudit(db, {
          workerId: w.workerId,
          action: 'LOYALTY_TIER_CLEARED',
          entityType: 'customers',
          entityId: req.customerId,
          beforeValue: before,
          afterValue: { tier: null },
          deviceId,
        });
        return { ok: true };
      },
      IPC_CHANNELS_LOYALTY.CUSTOMER_CLEAR_MANUAL_TIER,
    ),
  );
}
