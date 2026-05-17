// handlers.ts — IPC dispatcher for the core feature set (auth, shifts,
// sales, products, customers, device config). Wave H handlers live in
// handlers-wave-h.ts and call the helpers exported from this file.

import type { IpcMain } from 'electron';
import type { Database } from 'better-sqlite3';

import {
  IPC_CHANNELS_AUTH, IPC_CHANNELS_SHIFTS, IPC_CHANNELS_PRODUCTS,
  IPC_CHANNELS_CUSTOMERS, IPC_CHANNELS_SALES, IPC_CHANNELS_DEVICE,
  IPC_CHANNELS_SUPERVISOR, IPC_CHANNELS_PRINT, IPC_CHANNELS_RECOVERY,
  IPC_CHANNELS_PERIODS, IPC_CHANNELS_PENDING_ORDERS, IPC_CHANNELS_ROUTES,
  IPC_CHANNELS_ROUTE_RUNS, IPC_CHANNELS_DELIVERIES, IPC_CHANNELS_STOCKTAKE,
  IPC_CHANNELS_PROMOTIONS, IPC_CHANNELS_CUSTOMER_RETURNS,
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
  SupervisorVerifyPinRequest, SupervisorVerifyPinResponse,
  PrintLogRequest, PrintLogResponse,
  RecoveryListEligibleResponse,
  RecoveryVerifyAndResetRequest, RecoveryVerifyAndResetResponse,
  RecoveryRegenerateRequest, RecoveryRegenerateResponse,
  PeriodSealRequest, PeriodSealResponse,
  PeriodReopenRequest, PeriodReopenResponse,
  PeriodListRequest, PeriodListResponse,
  PendingOrdersCreateRequest, PendingOrdersCreateResponse,
  PendingOrdersListRequest, PendingOrdersListResponse,
  PendingOrdersGetRequest, PendingOrdersGetResponse,
  PendingOrdersCancelRequest, PendingOrdersCancelResponse,
  PendingOrdersConvertRequest, PendingOrdersConvertResponse,
  RoutesCreateRequest, RoutesCreateResponse,
  RoutesListRequest, RoutesListResponse,
  RoutesArchiveRequest, RoutesReactivateRequest,
  RoutesListStopsRequest, RoutesListStopsResponse,
  RoutesAddStopRequest, RoutesAddStopResponse,
  RoutesRemoveStopRequest, RoutesReorderStopsRequest,
  RoutesEmptyResponse,
  RouteRunsOpenRequest, RouteRunsOpenResponse,
  RouteRunsListRequest, RouteRunsListResponse,
  RouteRunsGetRequest, RouteRunsGetResponse,
  RouteRunsAssignRequest, RouteRunsUnassignRequest,
  RouteRunsCloseRequest, RouteRunsReconcileRequest, RouteRunsReopenRequest,
  RouteRunsEmptyResponse, RouteRunsMyOpenResponse,
  DeliveryRecordRequest, DeliveryRecordResponse,
  DeliveryListForRunRequest, DeliveryListForRunResponse,
  DeliveryGetForOrderRequest, DeliveryGetForOrderResponse,
  StocktakeOpenRequest, StocktakeOpenResponse,
  StocktakeRecordRequest, StocktakeRecordResponse,
  StocktakeListRequest, StocktakeListResponse,
  StocktakeLinesRequest, StocktakeLinesResponse,
  StocktakeCloseRequest, StocktakeCloseResponse,
  StocktakeCancelRequest, StocktakeCancelResponse,
  PromotionsListRequest, PromotionsListResponse,
  PromotionsCreateRequest, PromotionsCreateResponse,
  PromotionsIdRequest, PromotionsEmptyResponse,
  CustomerReturnRecordRequest, CustomerReturnRecordResponse,
  CustomerReturnListRequest, CustomerReturnListResponse,
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
import { verifySupervisorPin } from '../services/supervisorApprovals.js';
import { logAudit } from '../services/auditQuery.js';
import { v4 as uuidv4 } from 'uuid';
import {
  generateRecoveryCode, verifyRecoveryCodeAndResetPin,
  listRecoveryEligibleWorkers,
} from '../services/recovery.js';
import {
  sealDay, reopenDay, listRecentSeals,
} from '../services/periods.js';
import {
  createPendingOrder, listPendingOrders, getPendingOrder,
  cancelPendingOrder, convertToSale,
} from '../services/pendingOrders.js';
import {
  createRoute, listRoutes, archiveRoute, reactivateRoute,
  listStopsForRoute, addStop, removeStop, reorderStops,
} from '../services/routes.js';
import {
  openRouteRun, listRouteRuns, getRouteRun,
  assignOrderToRun, unassignOrderFromRun,
  closeRouteRun, reconcileRouteRun, reopenRouteRun,
  listRunsForDriver,
} from '../services/routeRuns.js';
import {
  recordDeliveryAttempt, listAttemptsForRun, getAttemptForOrder,
} from '../services/deliveryAttempts.js';
import {
  openStocktake, recordCount, listStocktakeEvents,
  listLinesForStocktake, closeStocktake, cancelStocktake,
} from '../services/stocktake.js';
import {
  listPromotions, createPromotion, archivePromotion, reactivatePromotion,
} from '../services/promotions.js';
import {
  recordCustomerReturn, listReturnsForCustomer,
} from '../services/customerReturns.js';

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

// requireDriverOrLikelier — allow DRIVER, SUPERVISOR, OWNER, FOUNDER.
// Driver-side endpoints should accept any of these so a depot lead
// can also exercise the flow during debriefs.
export function requireDriverOrLikelier(): SessionInfo {
  const s = requireWorker();
  if (s.role !== 'DRIVER' && s.role !== 'SUPERVISOR'
      && s.role !== 'OWNER' && s.role !== 'FOUNDER') {
    throw new Error('DRIVER role or higher required for this action.');
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
          // Multi-tender shape if the renderer sent one; legacy
          // paymentMethod + cashTendered otherwise. The service
          // normalises both internally.
          payments: req.payments,
          paymentMethod: req.paymentMethod,
          cashTenderedPesewas: req.cashTenderedPesewas,
          supervisorApprovalId: req.supervisorApprovalId,
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

  // ---- Supervisor PIN gate ----
  // Verifies a PIN against any active SUPERVISOR/OWNER/FOUNDER worker
  // and returns an approval id the caller passes into a downstream
  // elevated action (e.g. createSale for over-limit partials). Failed
  // attempts return a deliberately vague error so the caller can't
  // probe which roles are configured.
  ipcMain.handle(IPC_CHANNELS_SUPERVISOR.SUPERVISOR_VERIFY_PIN,
    wrap<SupervisorVerifyPinRequest, SupervisorVerifyPinResponse>(
      (req) => {
        const w = requireWorker();
        const r = verifySupervisorPin(db, {
          cashierWorkerId: w.workerId,
          pin: req.pin,
          purpose: req.purpose,
          context: req.context,
        }, deviceId);
        return {
          approvalId: r.approvalId,
          supervisorName: r.supervisorName,
          expiresAt: r.expiresAt,
        };
      },
      IPC_CHANNELS_SUPERVISOR.SUPERVISOR_VERIFY_PIN,
    ),
  );

  // ---- Print audit ----
  // The renderer triggers the OS print dialog locally (or, in a
  // future thermal-driver build, hands off to a main-side adapter).
  // Either way, every print attempt records one audit row so a
  // forensic reader can answer "did this receipt get printed?". The
  // row goes in regardless of whether the user actually clicks Print
  // in the OS dialog — recording the attempt is more useful than
  // recording silence.
  ipcMain.handle(IPC_CHANNELS_PRINT.PRINT_LOG,
    wrap<PrintLogRequest, PrintLogResponse>(
      (req) => {
        const w = requireWorker();
        const action = req.kind === 'STATEMENT'
          ? 'STATEMENT_PRINTED'
          : req.kind === 'REPRINT_RECEIPT'
            ? 'RECEIPT_REPRINTED'
            : 'RECEIPT_PRINTED';
        const entityType = req.kind === 'STATEMENT' ? 'customers' : 'sales';
        const auditId = `al-${uuidv4()}`;
        logAudit(db, {
          workerId: w.workerId,
          action,
          entityType,
          entityId: req.entityId,
          afterValue: { kind: req.kind, context: req.context ?? {} },
          deviceId,
        });
        return { auditId };
      },
      IPC_CHANNELS_PRINT.PRINT_LOG,
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

  // ---- OWNER PIN recovery (Section 10) ----
  // The first two are unauthenticated — the caller is locked out by
  // construction. The third is OWNER-gated for the routine regenerate.
  ipcMain.handle(IPC_CHANNELS_RECOVERY.RECOVERY_LIST_ELIGIBLE,
    wrap<{}, RecoveryListEligibleResponse>(
      () => ({ workers: listRecoveryEligibleWorkers(db) as RecoveryListEligibleResponse['workers'] }),
      IPC_CHANNELS_RECOVERY.RECOVERY_LIST_ELIGIBLE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_RECOVERY.RECOVERY_VERIFY_AND_RESET,
    wrap<RecoveryVerifyAndResetRequest, RecoveryVerifyAndResetResponse>(
      (req) => verifyRecoveryCodeAndResetPin(db, {
        targetWorkerId: req.workerId,
        submittedCode: req.code,
        newPin: req.newPin,
      }, deviceId),
      IPC_CHANNELS_RECOVERY.RECOVERY_VERIFY_AND_RESET,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_RECOVERY.RECOVERY_REGENERATE,
    wrap<RecoveryRegenerateRequest, RecoveryRegenerateResponse>(
      (req) => {
        const w = requireOwnerLike();
        return generateRecoveryCode(db, {
          targetWorkerId: req.targetWorkerId,
          issuedByWorkerId: w.workerId,
        }, deviceId);
      },
      IPC_CHANNELS_RECOVERY.RECOVERY_REGENERATE,
    ),
  );

  // ---- Period close / day lock (Section 3 + Section 8) ----
  ipcMain.handle(IPC_CHANNELS_PERIODS.PERIODS_SEAL_DAY,
    wrap<PeriodSealRequest, PeriodSealResponse>(
      (req) => {
        const w = requireOwnerLike();
        return sealDay(db, {
          locationId: req.locationId,
          date: req.date,
          sealedByWorkerId: w.workerId,
        }, deviceId);
      },
      IPC_CHANNELS_PERIODS.PERIODS_SEAL_DAY,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_PERIODS.PERIODS_REOPEN_DAY,
    wrap<PeriodReopenRequest, PeriodReopenResponse>(
      (req) => {
        const w = requireOwnerLike();
        return reopenDay(db, {
          locationId: req.locationId,
          date: req.date,
          reopenedByWorkerId: w.workerId,
          reason: req.reason,
        }, deviceId);
      },
      IPC_CHANNELS_PERIODS.PERIODS_REOPEN_DAY,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_PERIODS.PERIODS_LIST,
    wrap<PeriodListRequest, PeriodListResponse>(
      (req) => {
        requireWorker();
        return { seals: listRecentSeals(db, req.locationId, req.limit) };
      },
      IPC_CHANNELS_PERIODS.PERIODS_LIST,
    ),
  );

  // ---- Pending orders (Wave G chunk 1) ----
  // Open shift required for create (the intake worker stamps the
  // row) and convert (the conversion needs shift_id for the sale's
  // shift_id FK). List/get/cancel work without an open shift since
  // they don't mutate the till state.
  ipcMain.handle(IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_CREATE,
    wrap<PendingOrdersCreateRequest, PendingOrdersCreateResponse>(
      (req) => {
        const w = requireWorker();
        return createPendingOrder(db, {
          customerId: req.customerId,
          intakeChannel: req.intakeChannel,
          intakeWorkerId: w.workerId,
          requestedDeliveryDate: req.requestedDeliveryDate,
          requiresReview: req.requiresReview,
          lines: req.lines,
        }, deviceId);
      },
      IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_CREATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_LIST,
    wrap<PendingOrdersListRequest, PendingOrdersListResponse>(
      (req) => {
        requireWorker();
        return { orders: listPendingOrders(db, req) as PendingOrdersListResponse['orders'] };
      },
      IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_LIST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_GET,
    wrap<PendingOrdersGetRequest, PendingOrdersGetResponse>(
      (req) => {
        requireWorker();
        const r = getPendingOrder(db, req.pendingOrderId);
        return r as PendingOrdersGetResponse;
      },
      IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_GET,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_CANCEL,
    wrap<PendingOrdersCancelRequest, PendingOrdersCancelResponse>(
      (req) => {
        const w = requireWorker();
        cancelPendingOrder(db, {
          pendingOrderId: req.pendingOrderId,
          workerId: w.workerId,
          reason: req.reason,
        }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_CANCEL,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_CONVERT,
    wrap<PendingOrdersConvertRequest, PendingOrdersConvertResponse>(
      (req) => {
        const w = requireWorker();
        // Conversion writes a sales row; needs the worker's open
        // shift for shift_id + location.
        const openShift = db.prepare(
          `SELECT id AS shiftId, location_id AS locationId
             FROM shifts
            WHERE worker_id = ? AND closed_at IS NULL
            ORDER BY opened_at DESC LIMIT 1`,
        ).get(w.workerId) as { shiftId: string; locationId: string } | undefined;
        if (!openShift) {
          throw new Error('Open a shift before converting an order to a sale.');
        }
        return convertToSale(db, {
          pendingOrderId: req.pendingOrderId,
          workerId: w.workerId,
          shiftId: openShift.shiftId,
          locationId: openShift.locationId,
          channel: req.channel,
          payments: req.payments,
          supervisorApprovalId: req.supervisorApprovalId,
        }, deviceId);
      },
      IPC_CHANNELS_PENDING_ORDERS.PENDING_ORDERS_CONVERT,
    ),
  );

  // ---- Routes (Wave G chunk 3) ----
  // OWNER-only writes; any-role list/list-stops.
  ipcMain.handle(IPC_CHANNELS_ROUTES.ROUTES_CREATE,
    wrap<RoutesCreateRequest, RoutesCreateResponse>(
      (req) => {
        const w = requireOwnerLike();
        return createRoute(db, { ...req, workerId: w.workerId }, deviceId);
      },
      IPC_CHANNELS_ROUTES.ROUTES_CREATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTES.ROUTES_LIST,
    wrap<RoutesListRequest, RoutesListResponse>(
      (req) => {
        requireWorker();
        return { routes: listRoutes(db, req) as RoutesListResponse['routes'] };
      },
      IPC_CHANNELS_ROUTES.ROUTES_LIST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTES.ROUTES_ARCHIVE,
    wrap<RoutesArchiveRequest, RoutesEmptyResponse>(
      (req) => {
        const w = requireOwnerLike();
        archiveRoute(db, { routeId: req.routeId, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_ROUTES.ROUTES_ARCHIVE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTES.ROUTES_REACTIVATE,
    wrap<RoutesReactivateRequest, RoutesEmptyResponse>(
      (req) => {
        const w = requireOwnerLike();
        reactivateRoute(db, { routeId: req.routeId, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_ROUTES.ROUTES_REACTIVATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTES.ROUTES_LIST_STOPS,
    wrap<RoutesListStopsRequest, RoutesListStopsResponse>(
      (req) => {
        requireWorker();
        return { stops: listStopsForRoute(db, req.routeId) as RoutesListStopsResponse['stops'] };
      },
      IPC_CHANNELS_ROUTES.ROUTES_LIST_STOPS,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTES.ROUTES_ADD_STOP,
    wrap<RoutesAddStopRequest, RoutesAddStopResponse>(
      (req) => {
        const w = requireOwnerLike();
        return addStop(db, { ...req, workerId: w.workerId }, deviceId);
      },
      IPC_CHANNELS_ROUTES.ROUTES_ADD_STOP,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTES.ROUTES_REMOVE_STOP,
    wrap<RoutesRemoveStopRequest, RoutesEmptyResponse>(
      (req) => {
        const w = requireOwnerLike();
        removeStop(db, { stopId: req.stopId, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_ROUTES.ROUTES_REMOVE_STOP,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTES.ROUTES_REORDER_STOPS,
    wrap<RoutesReorderStopsRequest, RoutesEmptyResponse>(
      (req) => {
        const w = requireOwnerLike();
        reorderStops(db, { ...req, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_ROUTES.ROUTES_REORDER_STOPS,
    ),
  );

  // ---- Route runs (Wave G chunk 3d) ----
  ipcMain.handle(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_OPEN,
    wrap<RouteRunsOpenRequest, RouteRunsOpenResponse>(
      (req) => {
        const w = requireOwnerLike();
        return openRouteRun(db, { ...req, workerId: w.workerId }, deviceId);
      },
      IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_OPEN,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_LIST,
    wrap<RouteRunsListRequest, RouteRunsListResponse>(
      (req) => {
        requireWorker();
        return { runs: listRouteRuns(db, req) as RouteRunsListResponse['runs'] };
      },
      IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_LIST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_GET,
    wrap<RouteRunsGetRequest, RouteRunsGetResponse>(
      (req) => {
        requireWorker();
        return { run: getRouteRun(db, req.routeRunId) as RouteRunsGetResponse['run'] };
      },
      IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_GET,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_ASSIGN,
    wrap<RouteRunsAssignRequest, RouteRunsEmptyResponse>(
      (req) => {
        const w = requireWorker();
        assignOrderToRun(db, { ...req, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_ASSIGN,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_UNASSIGN,
    wrap<RouteRunsUnassignRequest, RouteRunsEmptyResponse>(
      (req) => {
        const w = requireWorker();
        unassignOrderFromRun(db, { ...req, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_UNASSIGN,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_CLOSE,
    wrap<RouteRunsCloseRequest, RouteRunsEmptyResponse>(
      (req) => {
        const w = requireWorker();
        closeRouteRun(db, { ...req, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_CLOSE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_RECONCILE,
    wrap<RouteRunsReconcileRequest, RouteRunsEmptyResponse>(
      (req) => {
        const w = requireOwnerLike();
        reconcileRouteRun(db, { ...req, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_RECONCILE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_REOPEN,
    wrap<RouteRunsReopenRequest, RouteRunsEmptyResponse>(
      (req) => {
        const w = requireOwnerLike();
        reopenRouteRun(db, { ...req, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_REOPEN,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_MY_OPEN,
    wrap<{}, RouteRunsMyOpenResponse>(
      () => {
        const w = requireDriverOrLikelier();
        return { runs: listRunsForDriver(db, w.workerId) as RouteRunsMyOpenResponse['runs'] };
      },
      IPC_CHANNELS_ROUTE_RUNS.ROUTE_RUNS_MY_OPEN,
    ),
  );

  // ---- Delivery attempts (Wave G chunk 4) ----
  ipcMain.handle(IPC_CHANNELS_DELIVERIES.DELIVERY_RECORD,
    wrap<DeliveryRecordRequest, DeliveryRecordResponse>(
      (req) => {
        const w = requireWorker();
        return recordDeliveryAttempt(db, { ...req, workerId: w.workerId }, deviceId);
      },
      IPC_CHANNELS_DELIVERIES.DELIVERY_RECORD,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_DELIVERIES.DELIVERY_LIST_FOR_RUN,
    wrap<DeliveryListForRunRequest, DeliveryListForRunResponse>(
      (req) => {
        requireWorker();
        return { attempts: listAttemptsForRun(db, req.routeRunId) as DeliveryListForRunResponse['attempts'] };
      },
      IPC_CHANNELS_DELIVERIES.DELIVERY_LIST_FOR_RUN,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_DELIVERIES.DELIVERY_GET_FOR_ORDER,
    wrap<DeliveryGetForOrderRequest, DeliveryGetForOrderResponse>(
      (req) => {
        requireWorker();
        return { attempt: getAttemptForOrder(db, req.pendingOrderId) as DeliveryGetForOrderResponse['attempt'] };
      },
      IPC_CHANNELS_DELIVERIES.DELIVERY_GET_FOR_ORDER,
    ),
  );

  // ---- Stocktake (Wave B.1) ----
  // open/cancel are OWNER-only; record/close/list/lines accept any
  // worker (counts are routine work for cashiers; close is OWNER
  // because it writes stock_movements adjustments).
  ipcMain.handle(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_OPEN,
    wrap<StocktakeOpenRequest, StocktakeOpenResponse>(
      (req) => {
        const w = requireOwnerLike();
        return openStocktake(db, { ...req, workerId: w.workerId }, deviceId);
      },
      IPC_CHANNELS_STOCKTAKE.STOCKTAKE_OPEN,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_RECORD,
    wrap<StocktakeRecordRequest, StocktakeRecordResponse>(
      (req) => {
        const w = requireWorker();
        return recordCount(db, { ...req, workerId: w.workerId }, deviceId);
      },
      IPC_CHANNELS_STOCKTAKE.STOCKTAKE_RECORD,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_LIST,
    wrap<StocktakeListRequest, StocktakeListResponse>(
      (req) => {
        requireWorker();
        return { events: listStocktakeEvents(db, req) as StocktakeListResponse['events'] };
      },
      IPC_CHANNELS_STOCKTAKE.STOCKTAKE_LIST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_LINES,
    wrap<StocktakeLinesRequest, StocktakeLinesResponse>(
      (req) => {
        requireWorker();
        return { lines: listLinesForStocktake(db, req.stocktakeEventId) as StocktakeLinesResponse['lines'] };
      },
      IPC_CHANNELS_STOCKTAKE.STOCKTAKE_LINES,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_CLOSE,
    wrap<StocktakeCloseRequest, StocktakeCloseResponse>(
      (req) => {
        const w = requireOwnerLike();
        return closeStocktake(db, { ...req, workerId: w.workerId }, deviceId);
      },
      IPC_CHANNELS_STOCKTAKE.STOCKTAKE_CLOSE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_STOCKTAKE.STOCKTAKE_CANCEL,
    wrap<StocktakeCancelRequest, StocktakeCancelResponse>(
      (req) => {
        const w = requireOwnerLike();
        cancelStocktake(db, { ...req, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_STOCKTAKE.STOCKTAKE_CANCEL,
    ),
  );

  // ---- Promotions (Wave D) ----
  ipcMain.handle(IPC_CHANNELS_PROMOTIONS.PROMOTIONS_LIST,
    wrap<PromotionsListRequest, PromotionsListResponse>(
      (req) => {
        requireWorker();
        return { promotions: listPromotions(db, req) as PromotionsListResponse['promotions'] };
      },
      IPC_CHANNELS_PROMOTIONS.PROMOTIONS_LIST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_PROMOTIONS.PROMOTIONS_CREATE,
    wrap<PromotionsCreateRequest, PromotionsCreateResponse>(
      (req) => {
        const w = requireOwnerLike();
        return createPromotion(db, { ...req, workerId: w.workerId }, deviceId);
      },
      IPC_CHANNELS_PROMOTIONS.PROMOTIONS_CREATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_PROMOTIONS.PROMOTIONS_ARCHIVE,
    wrap<PromotionsIdRequest, PromotionsEmptyResponse>(
      (req) => {
        const w = requireOwnerLike();
        archivePromotion(db, { promotionId: req.promotionId, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_PROMOTIONS.PROMOTIONS_ARCHIVE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_PROMOTIONS.PROMOTIONS_REACTIVATE,
    wrap<PromotionsIdRequest, PromotionsEmptyResponse>(
      (req) => {
        const w = requireOwnerLike();
        reactivatePromotion(db, { promotionId: req.promotionId, workerId: w.workerId }, deviceId);
        return { ok: true as const };
      },
      IPC_CHANNELS_PROMOTIONS.PROMOTIONS_REACTIVATE,
    ),
  );

  // ---- Customer returns (Wave C.3) ----
  // Record requires the worker's open shift (the cash refund
  // attaches to it; CREDIT refunds use it for the payment row's
  // shift_id). Supervisor approval is consumed inside the service.
  ipcMain.handle(IPC_CHANNELS_CUSTOMER_RETURNS.CUSTOMER_RETURN_RECORD,
    wrap<CustomerReturnRecordRequest, CustomerReturnRecordResponse>(
      (req) => {
        const w = requireWorker();
        const openShift = db.prepare(
          `SELECT id AS shiftId, location_id AS locationId
             FROM shifts WHERE worker_id = ? AND closed_at IS NULL
             ORDER BY opened_at DESC LIMIT 1`,
        ).get(w.workerId) as { shiftId: string; locationId: string } | undefined;
        if (!openShift) {
          throw new Error('Open a shift before recording a customer return.');
        }
        return recordCustomerReturn(db, {
          customerId: req.customerId,
          workerId: w.workerId,
          refundMethod: req.refundMethod,
          shiftId: openShift.shiftId,
          locationId: openShift.locationId,
          supervisorApprovalId: req.supervisorApprovalId,
          lines: req.lines,
          notes: req.notes,
        }, deviceId);
      },
      IPC_CHANNELS_CUSTOMER_RETURNS.CUSTOMER_RETURN_RECORD,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_CUSTOMER_RETURNS.CUSTOMER_RETURN_LIST,
    wrap<CustomerReturnListRequest, CustomerReturnListResponse>(
      (req) => {
        requireWorker();
        return { returns: listReturnsForCustomer(db, req.customerId, req.limit) as CustomerReturnListResponse['returns'] };
      },
      IPC_CHANNELS_CUSTOMER_RETURNS.CUSTOMER_RETURN_LIST,
    ),
  );
}
