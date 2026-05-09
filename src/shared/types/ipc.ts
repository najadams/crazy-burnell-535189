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

// -- Request/response shapes ----------------------------------------------

export type WorkerRole = 'CASHIER' | 'SUPERVISOR' | 'OWNER' | 'FOUNDER';

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
export interface SalesCreateRequest {
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  customerId?: string | null;
  lines: SaleLineInput[];
  paymentMethod: 'CASH' | 'MOMO' | 'BANK' | 'CREDIT';
  cashTenderedPesewas?: number;        // present for CASH; used for change calc
}
export interface SalesCreateResponse {
  saleId: string;
  totalPesewas: number;
  changePesewas: number;
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
  BACKUP_PICK_DIR: 'backup:pick-dir',
  BACKUP_RUN:      'backup:run',
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
    runBackup:     (req: BackupRunRequest) => Promise<IpcResponse<BackupRunResponse>>;
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
}

declare global {
  interface CounterApi {
    recordCustomerPayment: (req: RecordPaymentRequest) => Promise<IpcResponse<RecordPaymentResponse>>;
    openCreditSales:       (req: OpenCreditSalesRequest) => Promise<IpcResponse<OpenCreditSalesResponse>>;
    listPayments:          (req: PaymentsListRequest)  => Promise<IpcResponse<PaymentsListResponse>>;
    getSaleById:           (req: SaleGetByIdRequest)   => Promise<IpcResponse<SaleGetByIdResponse>>;
  }
}
