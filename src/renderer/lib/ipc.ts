// renderer/lib/ipc.ts — wraps window.counter so every call passes
// through humanizeError on error responses. The wrapper is an explicit
// object rebuild, NOT a Proxy: contextBridge exposes data properties as
// non-configurable, and Proxy `get` invariants forbid returning a
// different value than the underlying property (Section 1 / CLAUDE.md).

import type { IpcResponse } from '../../shared/types/ipc';

function humanizeError(error: string): string {
  if (!error) return 'Something went wrong.';
  if (/SQLITE_CONSTRAINT_UNIQUE/i.test(error))
    return 'A record with these details already exists.';
  if (/SQLITE_CONSTRAINT/i.test(error))
    return 'That value isn’t allowed by the database. Please double-check.';
  if (/Not logged in/i.test(error))
    return 'Your session has expired. Please log in again.';
  if (/OWNER or FOUNDER role required/i.test(error))
    return 'OWNER role is required for this action.';
  if (/Open a shift/i.test(error))
    return 'Open a shift before completing this action.';
  return error;
}

type AnyAsyncFn<T> = (...args: any[]) => Promise<IpcResponse<T>>;

function withHumanize<F extends AnyAsyncFn<any>>(fn: F): F {
  return (async (...args: any[]) => {
    const r = await fn(...args);
    if (r && (r as any).success === false) {
      return { success: false, error: humanizeError((r as any).error) };
    }
    return r;
  }) as F;
}

// `window.counter` is exposed by preload.ts with the full CounterApi
// surface. We rebuild it here with humanizeError wrapping.
const w = (window as any).counter as CounterApi;

export const counter: CounterApi = {
  listWorkers:               withHumanize(w.listWorkers.bind(w)),
  login:                     withHumanize(w.login.bind(w)),
  logout:                    withHumanize(w.logout.bind(w)),
  whoAmI:                    withHumanize(w.whoAmI.bind(w)),
  openShift:                 withHumanize(w.openShift.bind(w)),
  closeShift:                withHumanize(w.closeShift.bind(w)),
  currentShift:              withHumanize(w.currentShift.bind(w)),
  listProducts:              withHumanize(w.listProducts.bind(w)),
  searchProducts:            withHumanize(w.searchProducts.bind(w)),
  listCustomers:             withHumanize(w.listCustomers.bind(w)),
  getCustomer:               withHumanize(w.getCustomer.bind(w)),
  recentSalesForCustomer:    withHumanize(w.recentSalesForCustomer.bind(w)),
  createSale:                withHumanize(w.createSale.bind(w)),
  verifySupervisorPin:       withHumanize(w.verifySupervisorPin.bind(w)),
  logPrint:                  withHumanize(w.logPrint.bind(w)),
  listRecoveryEligible:      withHumanize(w.listRecoveryEligible.bind(w)),
  recoveryResetPin:          withHumanize(w.recoveryResetPin.bind(w)),
  regenerateRecoveryCode:    withHumanize(w.regenerateRecoveryCode.bind(w)),
  sealDay:                   withHumanize(w.sealDay.bind(w)),
  reopenDay:                 withHumanize(w.reopenDay.bind(w)),
  listSeals:                 withHumanize(w.listSeals.bind(w)),
  pendingOrderCreate:        withHumanize(w.pendingOrderCreate.bind(w)),
  pendingOrderList:          withHumanize(w.pendingOrderList.bind(w)),
  pendingOrderGet:           withHumanize(w.pendingOrderGet.bind(w)),
  pendingOrderCancel:        withHumanize(w.pendingOrderCancel.bind(w)),
  pendingOrderConvert:       withHumanize(w.pendingOrderConvert.bind(w)),
  routeCreate:               withHumanize(w.routeCreate.bind(w)),
  routeList:                 withHumanize(w.routeList.bind(w)),
  routeArchive:              withHumanize(w.routeArchive.bind(w)),
  routeReactivate:           withHumanize(w.routeReactivate.bind(w)),
  routeListStops:            withHumanize(w.routeListStops.bind(w)),
  routeAddStop:              withHumanize(w.routeAddStop.bind(w)),
  routeRemoveStop:           withHumanize(w.routeRemoveStop.bind(w)),
  routeReorderStops:         withHumanize(w.routeReorderStops.bind(w)),
  routeRunOpen:              withHumanize(w.routeRunOpen.bind(w)),
  routeRunList:              withHumanize(w.routeRunList.bind(w)),
  routeRunGet:               withHumanize(w.routeRunGet.bind(w)),
  routeRunAssign:            withHumanize(w.routeRunAssign.bind(w)),
  routeRunUnassign:          withHumanize(w.routeRunUnassign.bind(w)),
  routeRunClose:             withHumanize(w.routeRunClose.bind(w)),
  routeRunReconcile:         withHumanize(w.routeRunReconcile.bind(w)),
  routeRunReopen:            withHumanize(w.routeRunReopen.bind(w)),
  routeRunMyOpen:            withHumanize(w.routeRunMyOpen.bind(w)),
  deliveryRecord:            withHumanize(w.deliveryRecord.bind(w)),
  deliveryListForRun:        withHumanize(w.deliveryListForRun.bind(w)),
  deliveryGetForOrder:       withHumanize(w.deliveryGetForOrder.bind(w)),
  stocktakeOpen:             withHumanize(w.stocktakeOpen.bind(w)),
  stocktakeRecord:           withHumanize(w.stocktakeRecord.bind(w)),
  stocktakeList:             withHumanize(w.stocktakeList.bind(w)),
  stocktakeLines:            withHumanize(w.stocktakeLines.bind(w)),
  stocktakeClose:            withHumanize(w.stocktakeClose.bind(w)),
  stocktakeCancel:           withHumanize(w.stocktakeCancel.bind(w)),
  promotionList:             withHumanize(w.promotionList.bind(w)),
  promotionCreate:           withHumanize(w.promotionCreate.bind(w)),
  promotionArchive:          withHumanize(w.promotionArchive.bind(w)),
  promotionReactivate:       withHumanize(w.promotionReactivate.bind(w)),
  customerReturnRecord:      withHumanize(w.customerReturnRecord.bind(w)),
  customerReturnList:        withHumanize(w.customerReturnList.bind(w)),
  recentSales:               withHumanize(w.recentSales.bind(w)),
  deviceConfig:              withHumanize(w.deviceConfig.bind(w)),
  receiveStock:              withHumanize(w.receiveStock.bind(w)),
  stockOnHand:               withHumanize(w.stockOnHand.bind(w)),
  voidSale:                  withHumanize(w.voidSale.bind(w)),
  recordCashDrop:            withHumanize(w.recordCashDrop.bind(w)),
  changePin:                 withHumanize(w.changePin.bind(w)),
  createProduct:             withHumanize(w.createProduct.bind(w)),
  createCustomer:            withHumanize(w.createCustomer.bind(w)),
  pickBackupDir:             withHumanize(w.pickBackupDir.bind(w)),
  runBackup:                 withHumanize(w.runBackup.bind(w)),
  getBackupHeartbeat:        withHumanize(w.getBackupHeartbeat.bind(w)),
    recordCustomerPayment:     withHumanize(w.recordCustomerPayment.bind(w)),
  openCreditSales:           withHumanize(w.openCreditSales.bind(w)),
  listPayments:              withHumanize(w.listPayments.bind(w)),
  getSaleById:               withHumanize(w.getSaleById.bind(w)),
    // Wave H
  listLoyaltyThresholds:     withHumanize(w.listLoyaltyThresholds.bind(w)),
  upsertLoyaltyThreshold:    withHumanize(w.upsertLoyaltyThreshold.bind(w)),
  deactivateLoyaltyThreshold:withHumanize(w.deactivateLoyaltyThreshold.bind(w)),
  previewTier:               withHumanize(w.previewTier.bind(w)),
  customerScorecard:         withHumanize(w.customerScorecard.bind(w)),
  customerLeaderboard:       withHumanize(w.customerLeaderboard.bind(w)),
  setManualTier:             withHumanize(w.setManualTier.bind(w)),
  clearManualTier:           withHumanize(w.clearManualTier.bind(w)),
};
