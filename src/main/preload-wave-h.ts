// Wave H preload additions. Append to the api object in src/main/preload.ts.
// Pattern matches the existing wave preload blocks.

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS_LOYALTY } from '../shared/types/ipc-wave-h.js';
import type {
  LoyaltyListThresholdsRequest, LoyaltyUpsertThresholdRequest,
  LoyaltyDeactivateThresholdRequest, LoyaltyPreviewTierRequest,
  CustomerScorecardRequest, CustomerLeaderboardRequest,
  CustomerSetManualTierRequest, CustomerClearManualTierRequest,
} from '../shared/types/ipc-wave-h.js';

export const waveHPreload = {
  // --- Wave H: Customer performance & loyalty ---
  listLoyaltyThresholds: (req: LoyaltyListThresholdsRequest = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS_LOYALTY.LOYALTY_LIST_THRESHOLDS, req),
  upsertLoyaltyThreshold: (req: LoyaltyUpsertThresholdRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_LOYALTY.LOYALTY_UPSERT_THRESHOLD, req),
  deactivateLoyaltyThreshold: (req: LoyaltyDeactivateThresholdRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_LOYALTY.LOYALTY_DEACTIVATE_THRESHOLD, req),
  previewTier: (req: LoyaltyPreviewTierRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_LOYALTY.LOYALTY_PREVIEW_TIER, req),
  customerScorecard: (req: CustomerScorecardRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_LOYALTY.CUSTOMER_SCORECARD, req),
  customerLeaderboard: (req: CustomerLeaderboardRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_LOYALTY.CUSTOMER_LEADERBOARD, req),
  setManualTier: (req: CustomerSetManualTierRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_LOYALTY.CUSTOMER_SET_MANUAL_TIER, req),
  clearManualTier: (req: CustomerClearManualTierRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_LOYALTY.CUSTOMER_CLEAR_MANUAL_TIER, req),
};
