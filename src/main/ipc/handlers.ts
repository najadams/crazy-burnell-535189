// handlers.ts — IPC dispatcher for the core feature set (auth, shifts,
// sales, products, customers, device config). Wave H handlers live in
// handlers-wave-h.ts and call the helpers exported from this file.

import type { IpcMain } from 'electron';
import type { Database } from 'better-sqlite3';

import {
  IPC_CHANNELS_AUTH, IPC_CHANNELS_SHIFTS, IPC_CHANNELS_PRODUCTS,
  IPC_CHANNELS_CUSTOMERS, IPC_CHANNELS_SALES, IPC_CHANNELS_DEVICE,
} from '../../shared/types/ipc.js';
import type {
  IpcResponse, SessionInfo,
  AuthLoginRequest, AuthLoginResponse, AuthListWorkersResponse,
  ShiftOpenRequest, ShiftOpenResponse, ShiftCloseRequest, ShiftCloseResponse,
  ShiftCurrentResponse,
  ProductsListResponse, ProductsSearchRequest, ProductsSearchResponse,
  CustomersListRequest, CustomersListResponse,
  CustomersGetRequest, CustomersGetResponse,
  CustomersRecentSalesRequest, CustomersRecentSalesResponse,
  SalesCreateRequest, SalesCreateResponse,
  SalesRecentRequest, SalesRecentResponse,
  DeviceConfigResponse,
} from '../../shared/types/ipc.js';

import { listWorkers, login as loginService } from '../services/auth.js';
import {
  openShift as openShiftService, closeShift as closeShiftService,
  getCurrentShift,
} from '../services/shifts.js';
import { listProducts, searchProducts } from '../services/products.js';
import {
  listCustomers, getCustomer, recentSalesForCustomer,
} from '../services/customers.js';
import { createSale, recentSales } from '../services/sales.js';

// -- Session state ---------------------------------------------------------
// Single-process, single-user-at-a-time. login() sets, logout() clears.

let currentSession: SessionInfo | null = null;

export function getSession(): SessionInfo | null {
  return currentSession;
}

// -- Auth helpers (also passed to Wave H handlers) ------------------------

export function requireWorker(): SessionInfo {
  if (!currentSession) throw new Error('Not logged in.');
  return currentSession;
}

export function requireOwnerLike(): SessionInfo {
  const s = requireWorker();
  if (s.role !== 'OWNER' && s.role !== 'FOUNDER') {
    throw new Error('OWNER or FOUNDER role required for this action.');
  }
  return s;
}

// -- Wrap: turn a service call into an IpcResponse handler ---------------

export type Wrap = <Req, Res>(
  fn: (req: Req) => Res | Promise<Res>,
  channel: string,
) => (event: unknown, req: Req) => Promise<IpcResponse<Res>>;

export const wrap: Wrap = (fn, channel) => async (_event, req) => {
  try {
    const data = await fn(req);
    return { success: true, data };
  } catch (e: any) {
    // Log to main-process console so the developer can see; renderer
    // gets the rewritten message via humanizeError.
    console.error(`[ipc:${channel}]`, e?.message ?? e);
    return { success: false, error: e?.message ?? String(e) };
  }
};

// -- Helper: pick the open shift for the current worker --------------------

function getOpenShiftOrThrow(db: Database, workerId: string): {
  shiftId: string; locationId: string;
} {
  const row = db.prepare(
    `SELECT id AS shiftId, location_id AS locationId
       FROM shifts
      WHERE worker_id = ? AND closed_at IS NULL
      ORDER BY opened_at DESC LIMIT 1`,
  ).get(workerId) as { shiftId: string; locationId: string } | undefined;
  if (!row) throw new Error('Open a shift before completing this action.');
  return row;
}

// -- Registration ---------------------------------------------------------

export function registerCoreHandlers(
  ipcMain: IpcMain, db: Database, deviceId: string,
): void {
  // ---- Auth ----
  ipcMain.handle(IPC_CHANNELS_AUTH.AUTH_LIST_WORKERS,
    wrap<{}, AuthListWorkersResponse>(
      () => ({ workers: listWorkers(db) }),
      IPC_CHANNELS_AUTH.AUTH_LIST_WORKERS,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_AUTH.AUTH_LOGIN,
    wrap<AuthLoginRequest, AuthLoginResponse>(
      (req) => {
        const session = loginService(db, req.workerId, req.pin);
        currentSession = session;
        return { session };
      },
      IPC_CHANNELS_AUTH.AUTH_LOGIN,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_AUTH.AUTH_LOGOUT,
    wrap<{}, { ok: true }>(() => { currentSession = null; return { ok: true }; },
    IPC_CHANNELS_AUTH.AUTH_LOGOUT),
  );
  ipcMain.handle(IPC_CHANNELS_AUTH.AUTH_WHO_AM_I,
    wrap<{}, SessionInfo | null>(
      () => currentSession,
      IPC_CHANNELS_AUTH.AUTH_WHO_AM_I,
    ),
  );

  // ---- Shifts ----
  ipcMain.handle(IPC_CHANNELS_SHIFTS.SHIFT_OPEN,
    wrap<ShiftOpenRequest, ShiftOpenResponse>(
      (req) => {
        const w = requireWorker();
        // If the renderer didn't name a location, fall back to the only
        // active one. The single-location-demo case (Section 17 open
        // question) — fine for now. If multiple locations exist we
        // require an explicit choice.
        let locationId = req.locationId;
        if (!locationId) {
          const rows = db.prepare(
            `SELECT id FROM locations WHERE active = 1 ORDER BY created_at ASC`,
          ).all() as Array<{ id: string }>;
          if (rows.length === 0) throw new Error('No active location configured.');
          if (rows.length > 1) {
            throw new Error('Multiple locations configured — please pick one.');
          }
          locationId = rows[0]!.id;
        }
        return openShiftService(db, {
          workerId: w.workerId,
          locationId,
          openingAmountPesewas: req.openingAmountPesewas,
        }, deviceId);
      },
      IPC_CHANNELS_SHIFTS.SHIFT_OPEN,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_SHIFTS.SHIFT_CLOSE,
    wrap<ShiftCloseRequest, ShiftCloseResponse>(
      (req) => {
        const w = requireWorker();
        const open = getOpenShiftOrThrow(db, w.workerId);
        const r = closeShiftService(
          db, open.shiftId, w.workerId, req.countedAmountPesewas, deviceId,
        );
        return {
          shiftId: open.shiftId,
          expectedAmountPesewas: r.expectedAmountPesewas,
          countedAmountPesewas: req.countedAmountPesewas,
          deltaPesewas: r.deltaPesewas,
        };
      },
      IPC_CHANNELS_SHIFTS.SHIFT_CLOSE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_SHIFTS.SHIFT_CURRENT,
    wrap<{}, ShiftCurrentResponse>(
      () => {
        const w = requireWorker();
        return getCurrentShift(db, w.workerId);
      },
      IPC_CHANNELS_SHIFTS.SHIFT_CURRENT,
    ),
  );

  // ---- Products ----
  ipcMain.handle(IPC_CHANNELS_PRODUCTS.PRODUCTS_LIST,
    wrap<{}, ProductsListResponse>(
      () => { requireWorker(); return { products: listProducts(db) }; },
      IPC_CHANNELS_PRODUCTS.PRODUCTS_LIST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_PRODUCTS.PRODUCTS_SEARCH,
    wrap<ProductsSearchRequest, ProductsSearchResponse>(
      (req) => {
        requireWorker();
        return { products: searchProducts(db, req.query, req.limit) };
      },
      IPC_CHANNELS_PRODUCTS.PRODUCTS_SEARCH,
    ),
  );

  // ---- Customers ----
  ipcMain.handle(IPC_CHANNELS_CUSTOMERS.CUSTOMERS_LIST,
    wrap<CustomersListRequest, CustomersListResponse>(
      (req) => {
        requireWorker();
        return { customers: listCustomers(db, !!req?.includeBlocked) };
      },
      IPC_CHANNELS_CUSTOMERS.CUSTOMERS_LIST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_CUSTOMERS.CUSTOMERS_GET,
    wrap<CustomersGetRequest, CustomersGetResponse>(
      (req) => {
        requireWorker();
        return { customer: getCustomer(db, req.customerId) };
      },
      IPC_CHANNELS_CUSTOMERS.CUSTOMERS_GET,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_CUSTOMERS.CUSTOMERS_RECENT_SALES,
    wrap<CustomersRecentSalesRequest, CustomersRecentSalesResponse>(
      (req) => {
        requireWorker();
        return { sales: recentSalesForCustomer(db, req.customerId, req.limit) };
      },
      IPC_CHANNELS_CUSTOMERS.CUSTOMERS_RECENT_SALES,
    ),
  );

  // ---- Sales ----
  ipcMain.handle(IPC_CHANNELS_SALES.SALES_CREATE,
    wrap<SalesCreateRequest, SalesCreateResponse>(
      (req) => {
        const w = requireWorker();
        const open = getOpenShiftOrThrow(db, w.workerId);
        return createSale(db, {
          shiftId: open.shiftId,
          workerId: w.workerId,
          locationId: open.locationId,
          channel: req.channel,
          customerId: req.customerId ?? null,
          lines: req.lines,
          paymentMethod: req.paymentMethod,
          cashTenderedPesewas: req.cashTenderedPesewas,
        }, deviceId);
      },
      IPC_CHANNELS_SALES.SALES_CREATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_SALES.SALES_RECENT,
    wrap<SalesRecentRequest, SalesRecentResponse>(
      (req) => {
        requireWorker();
        return { sales: recentSales(db, req?.limit) };
      },
      IPC_CHANNELS_SALES.SALES_RECENT,
    ),
  );

  // ---- Device config ----
  ipcMain.handle(IPC_CHANNELS_DEVICE.DEVICE_CONFIG,
    wrap<{}, DeviceConfigResponse>(
      () => {
        const row = db.prepare(
          `SELECT shop_name AS shopName, shop_subtitle AS shopSubtitle,
                  owner_phone AS ownerPhone
             FROM device_config WHERE id = 1`,
        ).get() as Omit<DeviceConfigResponse, 'defaultLocationId'> | undefined;
        const loc = db.prepare(
          `SELECT id FROM locations WHERE active = 1
            ORDER BY created_at ASC LIMIT 1`,
        ).get() as { id: string } | undefined;
        return {
          ...(row ?? { shopName: 'Counter Shop', shopSubtitle: '', ownerPhone: null }),
          defaultLocationId: loc?.id ?? null,
        };
      },
      IPC_CHANNELS_DEVICE.DEVICE_CONFIG,
    ),
  );
}
