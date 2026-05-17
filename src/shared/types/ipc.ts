// ipc.ts — IPC contract between renderer and main.
//
// Every counter.* call resolves to IpcResponse<T>. Renderer wraps these
// in humanizeError() (src/renderer/lib/ipc.ts) which rewrites internal
// error strings to user-facing guidance.
//
// Channel constants are split per feature for grep-ability. The
// renderer-facing CounterApi interface is augmented across files via
// declaration merging (Wave E pattern).

// -- Generic response shape ------------------------------------------------

export type IpcResponse<T> =
  | { success: true;  data: T }
  | { success: false; error: string };

// -- Channel constants -----------------------------------------------------

export const IPC_CHANNELS_AUTH = {
  AUTH_LOGIN:        'auth:login',
  AUTH_LOGOUT:       'auth:logout',
  AUTH_WHO_AM_I:     'auth:who-am-i',
  AUTH_LIST_WORKERS: 'auth:list-workers',         // for the Login screen role picker
} as const;

export const IPC_CHANNELS_SHIFTS = {
  SHIFT_OPEN:    'shift:open',
  SHIFT_CLOSE:   'shift:close',
  SHIFT_CURRENT: 'shift:current',
} as const;

export const IPC_CHANNELS_PRODUCTS = {
  PRODUCTS_LIST:   'products:list',
  PRODUCTS_SEARCH: 'products:search',
} as const;

export const IPC_CHANNELS_CUSTOMERS = {
  CUSTOMERS_LIST:        'customers:list',
  CUSTOMERS_GET:         'customers:get',
  CUSTOMERS_RECENT_SALES: 'customers:recent-sales',
} as const;

export const IPC_CHANNELS_SALES = {
  SALES_CREATE: 'sales:create',
  SALES_RECENT: 'sales:recent',
} as const;

export const IPC_CHANNELS_DEVICE = {
  DEVICE_CONFIG: 'device:config',
} as const;

// Supervisor PIN gate — reusable elevation primitive (Section 11 + migration 0008).
export const IPC_CHANNELS_SUPERVISOR = {
  SUPERVISOR_VERIFY_PIN: 'supervisor:verify-pin',
} as const;

// Printing — the renderer renders the print HTML and triggers the OS
// dialog locally; main only logs the attempt to audit_log. When the
// thermal-printer swap happens, the main-side adapter takes over and
// the renderer's calling surface stays the same.
export const IPC_CHANNELS_PRINT = {
  PRINT_LOG: 'print:log',
} as const;

// OWNER PIN recovery — Section 10. Two unauthenticated channels for
// the locked-out-from-LoginScreen flow + one OWNER-gated channel for
// regenerate-from-Settings.
export const IPC_CHANNELS_RECOVERY = {
  RECOVERY_LIST_ELIGIBLE:    'recovery:list-eligible',
  RECOVERY_VERIFY_AND_RESET: 'recovery:verify-and-reset',
  RECOVERY_REGENERATE:       'recovery:regenerate',
} as const;

// Period close / day lock — Section 3 migration 0010, Section 8.
// OWNER-only seal/reopen plus a list endpoint for the Settings panel.
export const IPC_CHANNELS_PERIODS = {
  PERIODS_SEAL_DAY:   'periods:seal-day',
  PERIODS_REOPEN_DAY: 'periods:reopen-day',
  PERIODS_LIST:       'periods:list',
} as const;

// Pending orders — Wave G chunk 1. Section 18.3.
export const IPC_CHANNELS_PENDING_ORDERS = {
  PENDING_ORDERS_CREATE:   'pending-orders:create',
  PENDING_ORDERS_LIST:     'pending-orders:list',
  PENDING_ORDERS_GET:      'pending-orders:get',
  PENDING_ORDERS_CANCEL:   'pending-orders:cancel',
  PENDING_ORDERS_CONVERT:  'pending-orders:convert',
} as const;

// Customer returns — Wave C.3. Section 6.
export const IPC_CHANNELS_CUSTOMER_RETURNS = {
  CUSTOMER_RETURN_RECORD: 'customer-returns:record',
  CUSTOMER_RETURN_LIST:   'customer-returns:list',
} as const;

export type CustomerReturnRefundMethod = 'CASH' | 'CREDIT';

export interface CustomerReturnLineInputDto {
  productId: string;
  quantity: number;
  refundUnitPesewas: number;
  notes?: string;
}

export interface CustomerReturnRecordRequest {
  customerId: string;
  refundMethod: CustomerReturnRefundMethod;
  supervisorApprovalId: string;
  lines: CustomerReturnLineInputDto[];
  notes?: string;
}
export interface CustomerReturnRecordResponse {
  customerReturnId: string;
  totalRefundPesewas: number;
  newBalancePesewas?: number;
}

export interface CustomerReturnRowDto {
  id: string;
  customerId: string;
  refundMethod: CustomerReturnRefundMethod;
  totalRefundPesewas: number;
  notes: string | null;
  createdAt: string;
  createdBy: string;
  createdByName: string | null;
  lineCount: number;
}
export interface CustomerReturnListRequest { customerId: string; limit?: number }
export interface CustomerReturnListResponse { returns: CustomerReturnRowDto[] }

// Promotions — Wave D (bonus-unit "buy N get M free").
export const IPC_CHANNELS_PROMOTIONS = {
  PROMOTIONS_LIST:        'promotions:list',
  PROMOTIONS_CREATE:      'promotions:create',
  PROMOTIONS_ARCHIVE:     'promotions:archive',
  PROMOTIONS_REACTIVATE:  'promotions:reactivate',
} as const;

export type PromotionChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

export interface PromotionRowDto {
  id: string;
  productId: string;
  productName: string;
  channel: PromotionChannel | null;
  qtyBuy: number;
  qtyGetFree: number;
  validFrom: string;
  validTo: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
}
export interface PromotionsListRequest    { includeArchived?: boolean }
export interface PromotionsListResponse   { promotions: PromotionRowDto[] }
export interface PromotionsCreateRequest  {
  productId: string;
  channel: PromotionChannel | null;
  qtyBuy: number;
  qtyGetFree: number;
  validFrom: string;
  validTo: string | null;
  notes?: string;
}
export interface PromotionsCreateResponse { promotionId: string }
export interface PromotionsIdRequest      { promotionId: string }
export interface PromotionsEmptyResponse  { ok: true }

// Stocktake — Wave B.1 (cycle counting). Section 3 + 18 dependencies.
export const IPC_CHANNELS_STOCKTAKE = {
  STOCKTAKE_OPEN:    'stocktake:open',
  STOCKTAKE_RECORD:  'stocktake:record',
  STOCKTAKE_LIST:    'stocktake:list-events',
  STOCKTAKE_LINES:   'stocktake:list-lines',
  STOCKTAKE_CLOSE:   'stocktake:close',
  STOCKTAKE_CANCEL:  'stocktake:cancel',
} as const;

export interface StocktakeEventRowDto {
  id: string;
  locationId: string;
  locationName: string;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  notes: string | null;
  openedAt: string;
  openedBy: string;
  openedByName: string | null;
  closedAt: string | null;
  closedBy: string | null;
  cancelReason: string | null;
  lineCount: number;
  totalAbsoluteDelta: number;
}
export interface StocktakeLineRowDto {
  id: string;
  productId: string;
  productName: string;
  expectedQty: number;
  countedQty: number;
  deltaQty: number;
  notes: string | null;
  recordedAt: string;
}

export interface StocktakeOpenRequest    { locationId: string; notes?: string }
export interface StocktakeOpenResponse   { stocktakeEventId: string }
export interface StocktakeRecordRequest  { stocktakeEventId: string; productId: string; countedQty: number; notes?: string }
export interface StocktakeRecordResponse { stocktakeLineId: string; expectedQty: number; deltaQty: number }
export interface StocktakeListRequest    { locationId?: string; limit?: number }
export interface StocktakeListResponse   { events: StocktakeEventRowDto[] }
export interface StocktakeLinesRequest   { stocktakeEventId: string }
export interface StocktakeLinesResponse  { lines: StocktakeLineRowDto[] }
export interface StocktakeCloseRequest   { stocktakeEventId: string; supervisorApprovalId?: string }
export interface StocktakeCloseResponse  { adjustmentsWritten: number; totalAbsoluteDelta: number }
export interface StocktakeCancelRequest  { stocktakeEventId: string; reason: string }
export interface StocktakeCancelResponse { ok: true }

// Delivery attempts — Wave G chunk 4. Section 18.3.
export const IPC_CHANNELS_DELIVERIES = {
  DELIVERY_RECORD:        'deliveries:record',
  DELIVERY_LIST_FOR_RUN:  'deliveries:list-for-run',
  DELIVERY_GET_FOR_ORDER: 'deliveries:get-for-order',
} as const;

export type DeliveryOutcome = 'DELIVERED' | 'PARTIAL' | 'REFUSED' | 'MISSED';

export interface DeliveryAttemptRowDto {
  id: string;
  routeRunId: string;
  pendingOrderId: string;
  customerId: string;
  customerName: string;
  attemptedAt: string;
  outcome: DeliveryOutcome;
  collectedCashPesewas: number;
  collectedEmptiesCount: number;
  returnIntentLines: string | null;
  notes: string | null;
}

export interface DeliveryRecordRequest {
  routeRunId: string;
  pendingOrderId: string;
  outcome: DeliveryOutcome;
  collectedCashPesewas?: number;
  collectedEmptiesCount?: number;
  returnIntentLines?: string;
  notes?: string;
}
export interface DeliveryRecordResponse { deliveryAttemptId: string }

export interface DeliveryListForRunRequest { routeRunId: string }
export interface DeliveryListForRunResponse { attempts: DeliveryAttemptRowDto[] }

export interface DeliveryGetForOrderRequest { pendingOrderId: string }
export interface DeliveryGetForOrderResponse { attempt: DeliveryAttemptRowDto | null }

// Route runs — Wave G chunk 3d. Per-day instance of a route.
export const IPC_CHANNELS_ROUTE_RUNS = {
  ROUTE_RUNS_OPEN:        'route-runs:open',
  ROUTE_RUNS_LIST:        'route-runs:list',
  ROUTE_RUNS_GET:         'route-runs:get',
  ROUTE_RUNS_ASSIGN:      'route-runs:assign-order',
  ROUTE_RUNS_UNASSIGN:    'route-runs:unassign-order',
  ROUTE_RUNS_CLOSE:       'route-runs:close',
  ROUTE_RUNS_RECONCILE:   'route-runs:reconcile',
  ROUTE_RUNS_REOPEN:      'route-runs:reopen',
  ROUTE_RUNS_MY_OPEN:     'route-runs:my-open',
} as const;

export type RouteRunStatus = 'OPEN' | 'RETURNING' | 'CLOSED' | 'RECONCILED';

export interface RouteRunRowDto {
  id: string;
  routeId: string;
  routeName: string;
  runDate: string;
  driverId: string;
  driverName: string;
  status: RouteRunStatus;
  openedAt: string;
  closedAt: string | null;
  closingCashPesewas: number | null;
  reconciledAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  notes: string | null;
  assignedOrderCount: number;
  convertedOrderCount: number;
  cancelledOrderCount: number;
}

export interface RouteRunsOpenRequest {
  routeId: string;
  runDate: string;
  driverId: string;
  notes?: string;
}
export interface RouteRunsOpenResponse { routeRunId: string }

export interface RouteRunsListRequest {
  status?: RouteRunStatus | 'OPEN_OR_CLOSED';
  runDate?: string;
  limit?: number;
}
export interface RouteRunsListResponse { runs: RouteRunRowDto[] }

export interface RouteRunsGetRequest { routeRunId: string }
export interface RouteRunsGetResponse { run: RouteRunRowDto }

export interface RouteRunsAssignRequest { pendingOrderId: string; routeRunId: string }
export interface RouteRunsUnassignRequest { pendingOrderId: string }
export interface RouteRunsCloseRequest { routeRunId: string; closingCashPesewas: number; notes?: string }
export interface RouteRunsReconcileRequest { routeRunId: string; notes?: string }
export interface RouteRunsReopenRequest { routeRunId: string; reason: string }
export interface RouteRunsMyOpenResponse { runs: RouteRunRowDto[] }
export interface RouteRunsEmptyResponse { ok: true }

// Routes + route stops — Wave G chunk 3. Section 18.3.
export const IPC_CHANNELS_ROUTES = {
  ROUTES_CREATE:        'routes:create',
  ROUTES_LIST:          'routes:list',
  ROUTES_ARCHIVE:       'routes:archive',
  ROUTES_REACTIVATE:    'routes:reactivate',
  ROUTES_LIST_STOPS:    'routes:list-stops',
  ROUTES_ADD_STOP:      'routes:add-stop',
  ROUTES_REMOVE_STOP:   'routes:remove-stop',
  ROUTES_REORDER_STOPS: 'routes:reorder-stops',
} as const;

export interface RouteRowDto {
  id: string;
  name: string;
  weekdayPattern: string;
  active: boolean;
  notes: string | null;
  createdAt: string;
  stopCount: number;
}
export interface RouteStopRowDto {
  id: string;
  routeId: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  stopOrder: number;
}
export interface RoutesCreateRequest {
  name: string;
  weekdayPattern?: string;
  notes?: string;
}
export interface RoutesCreateResponse { routeId: string }
export interface RoutesListRequest  { includeArchived?: boolean }
export interface RoutesListResponse { routes: RouteRowDto[] }
export interface RoutesArchiveRequest   { routeId: string }
export interface RoutesReactivateRequest { routeId: string }
export interface RoutesListStopsRequest { routeId: string }
export interface RoutesListStopsResponse { stops: RouteStopRowDto[] }
export interface RoutesAddStopRequest    { routeId: string; customerId: string }
export interface RoutesAddStopResponse   { stopId: string; stopOrder: number }
export interface RoutesRemoveStopRequest { stopId: string }
export interface RoutesReorderStopsRequest { routeId: string; orderedStopIds: string[] }
export interface RoutesEmptyResponse { ok: true }

export type PendingOrderIntakeChannel = 'MANUAL' | 'PHONE_CALL' | 'WHATSAPP_TEXT';
export type PendingOrderStatus =
  | 'CREATED' | 'ASSIGNED' | 'PICKED' | 'OUT_FOR_DELIVERY'
  | 'DELIVERED' | 'FAILED' | 'CONVERTED' | 'CANCELLED';

export interface PendingOrderLineInputDto {
  productId: string;
  quantity: number;
  unitPricePesewasAtIntake: number;
  notes?: string;
}

export interface PendingOrderRowDto {
  id: string;
  customerId: string;
  customerName: string | null;
  intakeChannel: PendingOrderIntakeChannel;
  intakeWorkerId: string;
  intakeWorkerName: string | null;
  status: PendingOrderStatus;
  requiresReview: boolean;
  requestedDeliveryDate: string | null;
  assignedRouteRunId: string | null;
  conversionSaleId: string | null;
  convertedAt: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  totalAtIntakePesewas: number;
  lineCount: number;
}

export interface PendingOrderLineRowDto {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPricePesewasAtIntake: number;
  lineTotalPesewasAtIntake: number;
  notes: string | null;
}

export interface PendingOrdersCreateRequest {
  customerId: string;
  intakeChannel: PendingOrderIntakeChannel;
  requestedDeliveryDate?: string | null;
  requiresReview?: boolean;
  lines: PendingOrderLineInputDto[];
}
export interface PendingOrdersCreateResponse { pendingOrderId: string }

export interface PendingOrdersListRequest {
  status?: PendingOrderStatus | 'OPEN' | 'CLOSED';
  customerId?: string;
  routeRunId?: string;
  limit?: number;
}
export interface PendingOrdersListResponse { orders: PendingOrderRowDto[] }

export interface PendingOrdersGetRequest { pendingOrderId: string }
export interface PendingOrdersGetResponse {
  order: PendingOrderRowDto;
  lines: PendingOrderLineRowDto[];
}

export interface PendingOrdersCancelRequest { pendingOrderId: string; reason: string }
export interface PendingOrdersCancelResponse { ok: true }

export interface PendingOrdersConvertRequest {
  pendingOrderId: string;
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  payments: PaymentTenderInput[];
  supervisorApprovalId?: string;
}
export interface PendingOrdersConvertResponse { saleId: string }

export interface PeriodSealRequest {
  locationId: string;
  date: string;             // YYYY-MM-DD
}
export interface PeriodSealResponse {
  id: string;
}
export interface PeriodReopenRequest {
  locationId: string;
  date: string;
  reason: string;
}
export interface PeriodReopenResponse {
  id: string;
}
export interface PeriodListRequest {
  locationId: string;
  limit?: number;
}
export interface PeriodListResponse {
  seals: Array<{
    id: string;
    locationId: string;
    date: string;
    sealedAt: string;
    sealedBy: string;
    reopenedAt: string | null;
    reopenedBy: string | null;
    reopenReason: string | null;
  }>;
}

export interface RecoveryListEligibleResponse {
  workers: Array<{
    id: string;
    fullName: string;
    role: 'OWNER' | 'FOUNDER';
    hasRecoveryCode: boolean;
  }>;
}
export interface RecoveryVerifyAndResetRequest {
  workerId: string;
  code: string;
  newPin: string;
}
export interface RecoveryVerifyAndResetResponse {
  newRecoveryCode: string;
}
export interface RecoveryRegenerateRequest {
  // Target worker id. OWNER may regenerate for any OWNER/FOUNDER
  // (including themselves); FOUNDER same.
  targetWorkerId: string;
}
export interface RecoveryRegenerateResponse {
  code: string;
}

export type PrintKind = 'RECEIPT' | 'STATEMENT' | 'REPRINT_RECEIPT';

export interface PrintLogRequest {
  kind: PrintKind;
  // The entity the print targets — a sale id for receipts, a customer
  // id for statements. Threaded into audit_log.entity_id.
  entityId: string;
  // Optional snapshot of what was rendered (total pesewas, line count,
  // statement-as-of-date, etc.). Stored on the audit row's after_value
  // for forensic readers.
  context?: Record<string, unknown>;
}
export interface PrintLogResponse {
  auditId: string;
}

export type SupervisorApprovalPurpose =
  | 'OVER_LIMIT_PARTIAL'
  | 'OVER_THRESHOLD_DISCOUNT'
  | 'BREAKAGE'
  | 'VOID_SALE'
  | 'CUSTOMER_RETURN'
  | 'STOCKTAKE_LARGE_DELTA';

export interface SupervisorVerifyPinRequest {
  pin: string;
  purpose: SupervisorApprovalPurpose;
  // JSON-serialisable context snapshot stored on the approval row for
  // forensic readers ("what was this supervisor approving?").
  context?: Record<string, unknown>;
}
export interface SupervisorVerifyPinResponse {
  approvalId: string;
  supervisorName: string;
  expiresAt: string;
}

// -- Request/response shapes ----------------------------------------------

export type WorkerRole = 'CASHIER' | 'SUPERVISOR' | 'OWNER' | 'FOUNDER' | 'DRIVER';

export interface WorkerSummary {
  id: string;
  fullName: string;
  role: WorkerRole;
}

export interface SessionInfo {
  workerId: string;
  fullName: string;
  role: WorkerRole;
}

export interface AuthLoginRequest  { workerId: string; pin: string }
export interface AuthLoginResponse { session: SessionInfo }

export interface AuthListWorkersResponse { workers: WorkerSummary[] }

export interface ShiftOpenRequest  { openingAmountPesewas: number; locationId?: string }
export interface ShiftOpenResponse { shiftId: string }
export interface ShiftCloseRequest  { countedAmountPesewas: number }
export interface ShiftCloseResponse {
  shiftId: string;
  expectedAmountPesewas: number;
  countedAmountPesewas: number;
  deltaPesewas: number;
}
export interface ShiftCurrentResponse {
  shiftId: string | null;
  openedAt: string | null;
  openingAmountPesewas: number | null;
}

export interface ProductSummary {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  walkInPricePesewas: number;
  wholesalePricePesewas: number;
  routePricePesewas: number;
  costPricePesewas: number;
  active: boolean;
}
export interface ProductsListResponse { products: ProductSummary[] }
export interface ProductsSearchRequest { query: string; limit?: number }
export interface ProductsSearchResponse { products: ProductSummary[] }

export interface CustomerSummary {
  id: string;
  displayName: string;
  phone: string;
  customerType: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  creditLimitPesewas: number;
  currentBalancePesewas: number;
  blocked: boolean;
}
export interface CustomersListRequest { includeBlocked?: boolean }
export interface CustomersListResponse { customers: CustomerSummary[] }
export interface CustomersGetRequest { customerId: string }
export interface CustomersGetResponse { customer: CustomerSummary }
export interface CustomersRecentSalesRequest { customerId: string; limit?: number }
export interface CustomersRecentSalesResponse {
  sales: Array<{
    id: string;
    createdAt: string;
    totalPesewas: number;
    voided: boolean;
    paymentMethod: string;
    lineCount: number;
  }>;
}

export interface SaleLineInput {
  productId: string;
  quantity: number;
  unitPricePesewas: number;
  unitCostPesewas: number;
}
export type SalesPaymentMethod = 'CASH' | 'MOMO' | 'BANK' | 'CREDIT';

export interface PaymentTenderInput {
  method: SalesPaymentMethod;
  amountPesewas: number;
  paymentReference?: string;           // MoMo/bank reference; optional
  cashGivenPesewas?: number;           // CASH only; ≥ amountPesewas
}

export interface SalesCreateRequest {
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  customerId?: string | null;
  lines: SaleLineInput[];
  // ---- Multi-tender shape (preferred) ----
  payments?: PaymentTenderInput[];
  // ---- Legacy single-tender shape (still supported by the service) ----
  paymentMethod?: SalesPaymentMethod;
  cashTenderedPesewas?: number;        // present for CASH; used for change calc
  // Required when the CREDIT portion would push the customer over their
  // credit_limit_pesewas; obtained via SUPERVISOR_VERIFY_PIN.
  supervisorApprovalId?: string;
}
export interface SalesCreateResponse {
  saleId: string;
  totalPesewas: number;
  changePesewas: number;
  // Per-method breakdown so the renderer can render "Paid X, on credit
  // Y" without a follow-up round trip.
  cashPaidPesewas: number;
  momoPaidPesewas: number;
  bankPaidPesewas: number;
  creditPesewas: number;
}

export interface SalesRecentRequest { limit?: number }
export interface SalesRecentResponse {
  sales: Array<{
    id: string;
    createdAt: string;
    totalPesewas: number;
    customerId: string | null;
    customerName: string | null;
    workerName: string;
    voided: boolean;
  }>;
}

export interface DeviceConfigResponse {
  shopName: string;
  shopSubtitle: string;
  ownerPhone: string | null;
  defaultLocationId: string | null;
}

// -- Renderer-facing surface ----------------------------------------------
// Wave additions augment this via declaration merging (see
// ipc-wave-h.ts for the loyalty surface).

declare global {
  interface CounterApi {
    // auth
    listWorkers: () => Promise<IpcResponse<AuthListWorkersResponse>>;
    login:       (req: AuthLoginRequest) => Promise<IpcResponse<AuthLoginResponse>>;
    logout:      () => Promise<IpcResponse<{ ok: true }>>;
    whoAmI:      () => Promise<IpcResponse<SessionInfo | null>>;
    // shifts
    openShift:    (req: ShiftOpenRequest)  => Promise<IpcResponse<ShiftOpenResponse>>;
    closeShift:   (req: ShiftCloseRequest) => Promise<IpcResponse<ShiftCloseResponse>>;
    currentShift: () => Promise<IpcResponse<ShiftCurrentResponse>>;
    // products
    listProducts:   () => Promise<IpcResponse<ProductsListResponse>>;
    searchProducts: (req: ProductsSearchRequest) => Promise<IpcResponse<ProductsSearchResponse>>;
    // customers
    listCustomers:           (req: CustomersListRequest)         => Promise<IpcResponse<CustomersListResponse>>;
    getCustomer:             (req: CustomersGetRequest)          => Promise<IpcResponse<CustomersGetResponse>>;
    recentSalesForCustomer:  (req: CustomersRecentSalesRequest)  => Promise<IpcResponse<CustomersRecentSalesResponse>>;
    // sales
    createSale: (req: SalesCreateRequest) => Promise<IpcResponse<SalesCreateResponse>>;
    recentSales: (req: SalesRecentRequest) => Promise<IpcResponse<SalesRecentResponse>>;
    // device
    deviceConfig: () => Promise<IpcResponse<DeviceConfigResponse>>;
    // supervisor PIN gate
    verifySupervisorPin: (req: SupervisorVerifyPinRequest) => Promise<IpcResponse<SupervisorVerifyPinResponse>>;
    // print attempt audit
    logPrint: (req: PrintLogRequest) => Promise<IpcResponse<PrintLogResponse>>;
    // OWNER PIN recovery
    listRecoveryEligible:  () => Promise<IpcResponse<RecoveryListEligibleResponse>>;
    recoveryResetPin:      (req: RecoveryVerifyAndResetRequest) => Promise<IpcResponse<RecoveryVerifyAndResetResponse>>;
    regenerateRecoveryCode:(req: RecoveryRegenerateRequest) => Promise<IpcResponse<RecoveryRegenerateResponse>>;
    // day-lock / period-close
    sealDay:    (req: PeriodSealRequest)   => Promise<IpcResponse<PeriodSealResponse>>;
    reopenDay:  (req: PeriodReopenRequest) => Promise<IpcResponse<PeriodReopenResponse>>;
    listSeals:  (req: PeriodListRequest)   => Promise<IpcResponse<PeriodListResponse>>;
    // pending orders (Wave G chunk 1)
    pendingOrderCreate:  (req: PendingOrdersCreateRequest)  => Promise<IpcResponse<PendingOrdersCreateResponse>>;
    pendingOrderList:    (req: PendingOrdersListRequest)    => Promise<IpcResponse<PendingOrdersListResponse>>;
    pendingOrderGet:     (req: PendingOrdersGetRequest)     => Promise<IpcResponse<PendingOrdersGetResponse>>;
    pendingOrderCancel:  (req: PendingOrdersCancelRequest)  => Promise<IpcResponse<PendingOrdersCancelResponse>>;
    pendingOrderConvert: (req: PendingOrdersConvertRequest) => Promise<IpcResponse<PendingOrdersConvertResponse>>;
    // routes (Wave G chunk 3)
    routeCreate:        (req: RoutesCreateRequest)         => Promise<IpcResponse<RoutesCreateResponse>>;
    routeList:          (req: RoutesListRequest)           => Promise<IpcResponse<RoutesListResponse>>;
    routeArchive:       (req: RoutesArchiveRequest)        => Promise<IpcResponse<RoutesEmptyResponse>>;
    routeReactivate:    (req: RoutesReactivateRequest)     => Promise<IpcResponse<RoutesEmptyResponse>>;
    routeListStops:     (req: RoutesListStopsRequest)      => Promise<IpcResponse<RoutesListStopsResponse>>;
    routeAddStop:       (req: RoutesAddStopRequest)        => Promise<IpcResponse<RoutesAddStopResponse>>;
    routeRemoveStop:    (req: RoutesRemoveStopRequest)     => Promise<IpcResponse<RoutesEmptyResponse>>;
    routeReorderStops:  (req: RoutesReorderStopsRequest)   => Promise<IpcResponse<RoutesEmptyResponse>>;
    // route runs (Wave G chunk 3d)
    routeRunOpen:       (req: RouteRunsOpenRequest)         => Promise<IpcResponse<RouteRunsOpenResponse>>;
    routeRunList:       (req: RouteRunsListRequest)         => Promise<IpcResponse<RouteRunsListResponse>>;
    routeRunGet:        (req: RouteRunsGetRequest)          => Promise<IpcResponse<RouteRunsGetResponse>>;
    routeRunAssign:     (req: RouteRunsAssignRequest)       => Promise<IpcResponse<RouteRunsEmptyResponse>>;
    routeRunUnassign:   (req: RouteRunsUnassignRequest)     => Promise<IpcResponse<RouteRunsEmptyResponse>>;
    routeRunClose:      (req: RouteRunsCloseRequest)        => Promise<IpcResponse<RouteRunsEmptyResponse>>;
    routeRunReconcile:  (req: RouteRunsReconcileRequest)    => Promise<IpcResponse<RouteRunsEmptyResponse>>;
    routeRunReopen:     (req: RouteRunsReopenRequest)       => Promise<IpcResponse<RouteRunsEmptyResponse>>;
    routeRunMyOpen:     ()                                    => Promise<IpcResponse<RouteRunsMyOpenResponse>>;
    // delivery attempts (Wave G chunk 4)
    deliveryRecord:      (req: DeliveryRecordRequest)        => Promise<IpcResponse<DeliveryRecordResponse>>;
    deliveryListForRun:  (req: DeliveryListForRunRequest)    => Promise<IpcResponse<DeliveryListForRunResponse>>;
    deliveryGetForOrder: (req: DeliveryGetForOrderRequest)   => Promise<IpcResponse<DeliveryGetForOrderResponse>>;
    // stocktake
    stocktakeOpen:    (req: StocktakeOpenRequest)    => Promise<IpcResponse<StocktakeOpenResponse>>;
    stocktakeRecord:  (req: StocktakeRecordRequest)  => Promise<IpcResponse<StocktakeRecordResponse>>;
    stocktakeList:    (req: StocktakeListRequest)    => Promise<IpcResponse<StocktakeListResponse>>;
    stocktakeLines:   (req: StocktakeLinesRequest)   => Promise<IpcResponse<StocktakeLinesResponse>>;
    stocktakeClose:   (req: StocktakeCloseRequest)   => Promise<IpcResponse<StocktakeCloseResponse>>;
    stocktakeCancel:  (req: StocktakeCancelRequest)  => Promise<IpcResponse<StocktakeCancelResponse>>;
    // promotions (Wave D)
    promotionList:        (req: PromotionsListRequest)    => Promise<IpcResponse<PromotionsListResponse>>;
    promotionCreate:      (req: PromotionsCreateRequest)  => Promise<IpcResponse<PromotionsCreateResponse>>;
    promotionArchive:     (req: PromotionsIdRequest)      => Promise<IpcResponse<PromotionsEmptyResponse>>;
    promotionReactivate:  (req: PromotionsIdRequest)      => Promise<IpcResponse<PromotionsEmptyResponse>>;
    // customer returns (Wave C.3)
    customerReturnRecord: (req: CustomerReturnRecordRequest) => Promise<IpcResponse<CustomerReturnRecordResponse>>;
    customerReturnList:   (req: CustomerReturnListRequest)   => Promise<IpcResponse<CustomerReturnListResponse>>;
  }
  interface Window {
    counter: CounterApi;
  }
}

export {};

// =========================================================================
// Minimum-shippable wave: stock receive, void, cash drop, change PIN,
// add product, add customer, backup. Channels grouped per feature for
// grep-ability.
// =========================================================================

export const IPC_CHANNELS_STOCK = {
  STOCK_RECEIVE:  'stock:receive',
  STOCK_ON_HAND:  'stock:on-hand',
} as const;

export const IPC_CHANNELS_VOIDS = {
  VOID_SALE: 'sales:void',
} as const;

export const IPC_CHANNELS_CASH = {
  CASH_DROP_RECORD: 'cash:drop-record',
} as const;

export const IPC_CHANNELS_ADMIN = {
  WORKER_CHANGE_PIN:  'admin:worker-change-pin',
  PRODUCT_CREATE:     'admin:product-create',
  CUSTOMER_CREATE:    'admin:customer-create',
} as const;

export const IPC_CHANNELS_BACKUP = {
  BACKUP_PICK_DIR:      'backup:pick-dir',
  BACKUP_RUN:           'backup:run',
  BACKUP_GET_HEARTBEAT: 'backup:get-heartbeat',
} as const;

// --- Request/response shapes ---------------------------------------------

export interface ReceiptLineInput {
  productId: string;
  quantity: number;
  unitCostPesewas: number;
}
export interface StockReceiveRequest {
  supplierId?: string | null;
  lines: ReceiptLineInput[];
  notes?: string;
}
export interface StockReceiveResponse {
  receiptId: string;
  lineCount: number;
  totalUnits: number;
}

export interface StockOnHandRequest { locationId?: string }
export interface StockOnHandResponse {
  rows: Array<{
    productId: string;
    productName: string;
    sku: string;
    category: string | null;
    onHand: number;
    reorderThreshold: number;
    reorderQuantity: number;
    costPricePesewas: number;
  }>;
}

export interface VoidSaleRequest { saleId: string; reason: string }
export interface VoidSaleResponse { ok: true; reversedBalancePesewas: number }

export type CashDropReason =
  | 'OWNER_TAKE' | 'SUPPLIER_PAYMENT' | 'RUNNER_ADVANCE'
  | 'CUSTOMER_REFUND' | 'EXPENSE' | 'OTHER';
export interface CashDropRecordRequest {
  amountPesewas: number;
  reason: CashDropReason;
  note: string;
}
export interface CashDropRecordResponse { dropId: string }

export interface WorkerChangePinRequest { oldPin: string; newPin: string }
export interface WorkerChangePinResponse { ok: true }

export interface ProductCreateRequest {
  sku: string;
  name: string;
  category: string | null;
  costPricePesewas: number;
  walkInPricePesewas: number;
  wholesalePricePesewas: number;
  routePricePesewas: number;
  reorderThreshold: number;
  reorderQuantity: number;
  unitVolumeMl: number | null;
  isReturnable: boolean;
  bottleDepositPesewas: number;
}
export interface ProductCreateResponse { productId: string }

export interface CustomerCreateRequest {
  displayName: string;
  phone: string;
  customerType: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  creditLimitPesewas: number;
  preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
}
export interface CustomerCreateResponse { customerId: string }

export interface BackupPickDirResponse { path: string | null }
export interface BackupRunRequest { targetDir: string }
export interface BackupRunResponse {
  targetPath: string;
  sizeBytes: number;
  timestampISO: string;
}

export interface BackupHeartbeat {
  timestampISO: string;
  targetPath: string;
  sizeBytes: number;
}
export interface BackupHeartbeatResponse {
  heartbeat: BackupHeartbeat | null;
}

// --- CounterApi additions (declaration merging) ---------------------------

declare global {
  interface CounterApi {
    // stock
    receiveStock:  (req: StockReceiveRequest)  => Promise<IpcResponse<StockReceiveResponse>>;
    stockOnHand:   (req: StockOnHandRequest)   => Promise<IpcResponse<StockOnHandResponse>>;
    // voids
    voidSale:      (req: VoidSaleRequest)      => Promise<IpcResponse<VoidSaleResponse>>;
    // cash drops
    recordCashDrop:(req: CashDropRecordRequest) => Promise<IpcResponse<CashDropRecordResponse>>;
    // admin
    changePin:     (req: WorkerChangePinRequest) => Promise<IpcResponse<WorkerChangePinResponse>>;
    createProduct: (req: ProductCreateRequest)   => Promise<IpcResponse<ProductCreateResponse>>;
    createCustomer:(req: CustomerCreateRequest)  => Promise<IpcResponse<CustomerCreateResponse>>;
    // backup
    pickBackupDir: () => Promise<IpcResponse<BackupPickDirResponse>>;
    runBackup:                 (req: BackupRunRequest) => Promise<IpcResponse<BackupRunResponse>>;
    getBackupHeartbeat:        () => Promise<IpcResponse<BackupHeartbeatResponse>>;
  }
}

// =========================================================================
// Wave: customer payments + sale detail / receipt.
// =========================================================================

export const IPC_CHANNELS_PAYMENTS = {
  CUSTOMER_RECORD_PAYMENT:   'customer:record-payment',
  CUSTOMER_OPEN_CREDIT:      'customer:open-credit-sales',
  CUSTOMER_PAYMENTS_LIST:    'customer:payments-list',
} as const;

export const IPC_CHANNELS_SALE_DETAIL = {
  SALE_GET_BY_ID: 'sales:get-by-id',
} as const;

export type CustomerPaymentMethod = 'CASH' | 'MOMO' | 'BANK' | 'RETURN_CREDIT';

export interface RecordPaymentRequest {
  customerId: string;
  amountPesewas: number;
  paymentMethod: CustomerPaymentMethod;
  paymentReference?: string;
  notes?: string;
}
export interface RecordPaymentResponse {
  paymentId: string;
  allocations: Array<{ saleId: string; amountPesewas: number }>;
  unallocatedPesewas: number;
  newBalancePesewas: number;
}

export interface OpenCreditSalesRequest { customerId: string }
export interface OpenCreditSalesResponse {
  sales: Array<{
    saleId: string;
    createdAt: string;
    totalPesewas: number;
    paidPesewas: number;
    openBalancePesewas: number;
    paymentMethodOriginal: string;
    channel: string;
  }>;
}

export interface PaymentsListRequest { customerId: string; limit?: number }
export interface PaymentsListResponse {
  payments: Array<{
    paymentId: string;
    createdAt: string;
    amountPesewas: number;
    paymentMethod: CustomerPaymentMethod;
    paymentReference: string | null;
    notes: string | null;
    workerName: string;
    allocationCount: number;
    unallocatedPesewas: number;
  }>;
}

export interface SaleGetByIdRequest { saleId: string }
export interface SaleGetByIdResponse {
  sale: {
    id: string;
    createdAt: string;
    channel: string;
    paymentMethod: string;
    isCredit: boolean;
    voided: boolean;
    voidedAt: string | null;
    voidReason: string | null;
    subtotalPesewas: number;
    totalPesewas: number;
  };
  customer: { id: string; displayName: string; phone: string } | null;
  worker: { id: string; fullName: string };
  lines: Array<{
    id: string;
    productId: string;
    productName: string;
    productSku: string;
    quantity: number;
    unitPricePesewas: number;
    lineTotalPesewas: number;
    kind: string;
  }>;
  shopHeader: {
    shopName: string;
    shopSubtitle: string;
    ownerPhone: string | null;
  };
  paymentBreakdown: {
    cashPaidPesewas: number;
    momoPaidPesewas: number;
    bankPaidPesewas: number;
    creditPesewas: number;
    changePesewas: number;
  };
}

declare global {
  interface CounterApi {
    recordCustomerPayment: (req: RecordPaymentRequest) => Promise<IpcResponse<RecordPaymentResponse>>;
    openCreditSales:       (req: OpenCreditSalesRequest) => Promise<IpcResponse<OpenCreditSalesResponse>>;
    listPayments:          (req: PaymentsListRequest)  => Promise<IpcResponse<PaymentsListResponse>>;
    getSaleById:           (req: SaleGetByIdRequest)   => Promise<IpcResponse<SaleGetByIdResponse>>;
  }
}
