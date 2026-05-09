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
