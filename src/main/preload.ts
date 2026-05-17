// preload.ts — bridges the renderer's window.counter to the main
// process's IPC handlers via Electron's contextBridge. The renderer
// has contextIsolation on and nodeIntegration off (security), so the
// only path between renderer and main is through this surface.

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS_AUTH, IPC_CHANNELS_SHIFTS, IPC_CHANNELS_PRODUCTS,
  IPC_CHANNELS_CUSTOMERS, IPC_CHANNELS_SALES, IPC_CHANNELS_DEVICE,
  IPC_CHANNELS_STOCK, IPC_CHANNELS_VOIDS, IPC_CHANNELS_CASH,
  IPC_CHANNELS_ADMIN, IPC_CHANNELS_BACKUP,
  IPC_CHANNELS_PAYMENTS, IPC_CHANNELS_SALE_DETAIL,
  IPC_CHANNELS_SUPERVISOR, IPC_CHANNELS_PRINT,
  IPC_CHANNELS_RECOVERY,
  IPC_CHANNELS_PERIODS,
  IPC_CHANNELS_PENDING_ORDERS,
  IPC_CHANNELS_ROUTES,
  IPC_CHANNELS_ROUTE_RUNS,
  IPC_CHANNELS_DELIVERIES,
  IPC_CHANNELS_STOCKTAKE,
  IPC_CHANNELS_PROMOTIONS,
  IPC_CHANNELS_CUSTOMER_RETURNS,
} from '../shared/types/ipc.js';
import { waveHPreload } from './preload-wave-h.js';

const api = {
  // ---- Auth ----
  listWorkers: () =>
    ipcRenderer.invoke(IPC_CHANNELS_AUTH.AUTH_LIST_WORKERS, {}),
  login: (req: { workerId: string; pin: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS_AUTH.AUTH_LOGIN, req),
  logout: () =>
    ipcRenderer.invoke(IPC_CHANNELS_AUTH.AUTH_LOGOUT, {}),
  whoAmI: () =>
    ipcRenderer.invoke(IPC_CHANNELS_AUTH.AUTH_WHO_AM_I, {}),

  // ---- Shifts ----
  openShift: (req: { openingAmountPesewas: number; locationId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS_SHIFTS.SHIFT_OPEN, req),
  closeShift: (req: { countedAmountPesewas: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS_SHIFTS.SHIFT_CLOSE, req),
  currentShift: () =>
    ipcRenderer.invoke(IPC_CHANNELS_SHIFTS.SHIFT_CURRENT, {}),

  // ---- Products ----
  listProducts: () =>
    ipcRenderer.invoke(IPC_CHANNELS_PRODUCTS.PRODUCTS_LIST, {}),
  searchProducts: (req: { query: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS_PRODUCTS.PRODUCTS_SEARCH, req),

  // ---- Customers ----
  listCustomers: (req: { includeBlocked?: boolean } = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS_CUSTOMERS.CUSTOMERS_LIST, req),
  getCustomer: (req: { customerId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS_CUSTOMERS.CUSTOMERS_GET, req),
  recentSalesForCustomer: (req: { customerId: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS_CUSTOMERS.CUSTOMERS_RECENT_SALES, req),

  // ---- Sales ----
  createSale: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_SALES.SALES_CREATE, req),
  verifySupervisorPin: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_SUPERVISOR.SUPERVISOR_VERIFY_PIN, req),
  logPrint: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PRINT.PRINT_LOG, req),
  recentSales: (req: { limit?: number } = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS_SALES.SALES_RECENT, req),

  // ---- Device ----
  deviceConfig: () =>
    ipcRenderer.invoke(IPC_CHANNELS_DEVICE.DEVICE_CONFIG, {}),

  // ---- Stock / void / cash drop / admin / backup ----
  receiveStock: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_STOCK.STOCK_RECEIVE, req),
  stockOnHand: (req: any = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS_STOCK.STOCK_ON_HAND, req),
  voidSale: (req: { saleId: string; reason: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS_VOIDS.VOID_SALE, req),
  recordCashDrop: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_CASH.CASH_DROP_RECORD, req),
  changePin: (req: { oldPin: string; newPin: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS_ADMIN.WORKER_CHANGE_PIN, req),
  createProduct: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ADMIN.PRODUCT_CREATE, req),
  createCustomer: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ADMIN.CUSTOMER_CREATE, req),
  pickBackupDir: () =>
    ipcRenderer.invoke(IPC_CHANNELS_BACKUP.BACKUP_PICK_DIR, {}),
  runBackup: (req: { targetDir: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS_BACKUP.BACKUP_RUN, req),
  getBackupHeartbeat: () =>
    ipcRenderer.invoke(IPC_CHANNELS_BACKUP.BACKUP_GET_HEARTBEAT, {}),


  // ---- OWNER PIN recovery ----
  listRecoveryEligible: () =>
    ipcRenderer.invoke(IPC_CHANNELS_RECOVERY.RECOVERY_LIST_ELIGIBLE, {}),
  recoveryResetPin: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_RECOVERY.RECOVERY_VERIFY_AND_RESET, req),
  regenerateRecoveryCode: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_RECOVERY.RECOVERY_REGENERATE, req),

  // ---- Period close / day lock ----
  sealDay: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PERIODS.PERIODS_SEAL_DAY, req),
  reopenDay: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PERIODS.PERIODS_REOPEN_DAY, req),
  listSeals: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PERIODS.PERIODS_LIST, req),

  // ---- Pending orders (Wave G chunk 1) ----
  pendingOrderCreate: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_CREATE, req),
  pendingOrderList: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_LIST, req),
  pendingOrderGet: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_GET, req),
  pendingOrderCancel: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_CANCEL, req),
  pendingOrderConvert: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_CONVERT, req),
  routeCreate: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTES.ROUTES_CREATE, req),
  routeList: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTES.ROUTES_LIST, req),
  routeArchive: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTES.ROUTES_ARCHIVE, req),
  routeReactivate: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTES.ROUTES_REACTIVATE, req),
  routeListStops: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTES.ROUTES_LIST_STOPS, req),
  routeAddStop: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTES.ROUTES_ADD_STOP, req),
  routeRemoveStop: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTES.ROUTES_REMOVE_STOP, req),
  routeReorderStops: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTES.ROUTES_REORDER_STOPS, req),
  routeRunOpen: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_OPEN, req),
  routeRunList: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_LIST, req),
  routeRunGet: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_GET, req),
  routeRunAssign: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_ASSIGN, req),
  routeRunUnassign: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_UNASSIGN, req),
  routeRunClose: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_CLOSE, req),
  routeRunReconcile: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_RECONCILE, req),
  routeRunReopen: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_REOPEN, req),
  routeRunMyOpen: () =>
    ipcRenderer.invoke(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_MY_OPEN, {}),
  deliveryRecord: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_DELIVERIES.DELIVERY_RECORD, req),
  deliveryListForRun: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_DELIVERIES.DELIVERY_LIST_FOR_RUN, req),
  deliveryGetForOrder: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_DELIVERIES.DELIVERY_GET_FOR_ORDER, req),
  stocktakeOpen: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_OPEN, req),
  stocktakeRecord: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_RECORD, req),
  stocktakeList: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_LIST, req),
  stocktakeLines: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_LINES, req),
  stocktakeClose: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_CLOSE, req),
  stocktakeCancel: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_CANCEL, req),
  promotionList: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PROMOTIONS.PROMOTIONS_LIST, req),
  promotionCreate: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PROMOTIONS.PROMOTIONS_CREATE, req),
  promotionArchive: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PROMOTIONS.PROMOTIONS_ARCHIVE, req),
  promotionReactivate: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PROMOTIONS.PROMOTIONS_REACTIVATE, req),
  customerReturnRecord: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_CUSTOMER_RETURNS.CUSTOMER_RETURN_RECORD, req),
  customerReturnList: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_CUSTOMER_RETURNS.CUSTOMER_RETURN_LIST, req),

  // ---- Customer payments + sale detail ----
  recordCustomerPayment: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_PAYMENTS.CUSTOMER_RECORD_PAYMENT, req),
  openCreditSales: (req: { customerId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS_PAYMENTS.CUSTOMER_OPEN_CREDIT, req),
  listPayments: (req: { customerId: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS_PAYMENTS.CUSTOMER_PAYMENTS_LIST, req),
  getSaleById: (req: { saleId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS_SALE_DETAIL.SALE_GET_BY_ID, req),

  // ---- Wave H ----
  ...waveHPreload,
};

contextBridge.exposeInMainWorld('counter', api);
