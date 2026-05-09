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
