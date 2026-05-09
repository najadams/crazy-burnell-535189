// Wave H IPC additions. Append the channels block to the IPC_CHANNELS_*
// constant set in src/shared/types/ipc.ts and add the request/response
// interfaces below. Pattern matches existing wave additions (Wave G, etc).

import type { IpcResponse } from './ipc';
import type { LoyaltyTier, LoyaltyMetric, ThresholdRow } from '../../main/services/loyaltyTiers';
import type { CustomerScorecard, ScorecardWindow } from '../../main/services/customerScorecard';
import type { LeaderboardRow } from '../../main/services/customerLeaderboard';

// --- Channel constants ----------------------------------------------------

export const IPC_CHANNELS_LOYALTY = {
  LOYALTY_LIST_THRESHOLDS:      'loyalty:list-thresholds',
  LOYALTY_UPSERT_THRESHOLD:     'loyalty:upsert-threshold',
  LOYALTY_DEACTIVATE_THRESHOLD: 'loyalty:deactivate-threshold',
  LOYALTY_PREVIEW_TIER:         'loyalty:preview-tier',
  CUSTOMER_SCORECARD:           'customer:scorecard',
  CUSTOMER_LEADERBOARD:         'customer:leaderboard',
  CUSTOMER_SET_MANUAL_TIER:     'customer:set-manual-tier',
  CUSTOMER_CLEAR_MANUAL_TIER:   'customer:clear-manual-tier',
} as const;

// --- Request / response shapes -------------------------------------------

export interface LoyaltyListThresholdsRequest {
  includeInactive?: boolean;
}
export interface LoyaltyListThresholdsResponse {
  thresholds: ThresholdRow[];
}

export interface LoyaltyUpsertThresholdRequest {
  id?: string;
  tier: LoyaltyTier;
  metric: LoyaltyMetric;
  windowDays: number;
  minValue: number;
  notes?: string | null;
}
export interface LoyaltyUpsertThresholdResponse { id: string }

export interface LoyaltyDeactivateThresholdRequest { id: string }
export interface LoyaltyDeactivateThresholdResponse { ok: true }

export interface LoyaltyPreviewTierRequest { customerId: string }
export interface LoyaltyPreviewTierResponse {
  computed: LoyaltyTier | null;
  effective: LoyaltyTier | null;
  manual: LoyaltyTier | null;
}

export interface CustomerScorecardRequest {
  customerId: string;
  /** Either supply windowDays for "last N days ending now", OR explicit ISO bounds. */
  windowDays?: number;
  windowStartISO?: string;
  windowEndISO?: string;
}
export interface CustomerScorecardResponse {
  scorecard: CustomerScorecard;
}

export interface CustomerLeaderboardRequest {
  windowStartISO: string;
  windowEndISO: string;
  metric: 'REVENUE_PESEWAS' | 'MARGIN_PESEWAS' | 'ORDER_COUNT';
  limit?: number;
  includeBlocked?: boolean;
  channel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
}
export interface CustomerLeaderboardResponse {
  rows: LeaderboardRow[];
}

export interface CustomerSetManualTierRequest {
  customerId: string;
  tier: LoyaltyTier;
  reason?: string | null;
}
export interface CustomerSetManualTierResponse { ok: true }

export interface CustomerClearManualTierRequest { customerId: string }
export interface CustomerClearManualTierResponse { ok: true }

// --- Renderer-facing CounterApi additions ---------------------------------
// Append to src/renderer/lib/ipc.ts via the same declaration-merging
// pattern Wave E established (Section 13). The interface below is a
// drop-in `interface CounterApi { ... }` augmentation block.

declare global {
  interface CounterApi {
    listLoyaltyThresholds: (req: LoyaltyListThresholdsRequest)
      => Promise<IpcResponse<LoyaltyListThresholdsResponse>>;
    upsertLoyaltyThreshold: (req: LoyaltyUpsertThresholdRequest)
      => Promise<IpcResponse<LoyaltyUpsertThresholdResponse>>;
    deactivateLoyaltyThreshold: (req: LoyaltyDeactivateThresholdRequest)
      => Promise<IpcResponse<LoyaltyDeactivateThresholdResponse>>;
    previewTier: (req: LoyaltyPreviewTierRequest)
      => Promise<IpcResponse<LoyaltyPreviewTierResponse>>;
    customerScorecard: (req: CustomerScorecardRequest)
      => Promise<IpcResponse<CustomerScorecardResponse>>;
    customerLeaderboard: (req: CustomerLeaderboardRequest)
      => Promise<IpcResponse<CustomerLeaderboardResponse>>;
    setManualTier: (req: CustomerSetManualTierRequest)
      => Promise<IpcResponse<CustomerSetManualTierResponse>>;
    clearManualTier: (req: CustomerClearManualTierRequest)
      => Promise<IpcResponse<CustomerClearManualTierResponse>>;
  }
}
