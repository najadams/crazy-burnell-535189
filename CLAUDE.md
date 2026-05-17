# Counter — System Specification

A keyboard-first Electron POS, originally built for a single-shop Ghanaian
beverage wholesaler, now also the planned operating system for a
**family-owned route-based FMCG distribution business** transitioning out
of saturated walk-in wholesale into scheduled retailer delivery in Greater
Accra. Strong forensic features (append-only audit log, blind cash
counts, supervisor PIN gates, stocktake-corrected shrinkage). Single-device,
offline-first, file-based SQLite. No cloud, no PII outside the shop's
premises — until the route-distribution extensions in Section 18 require
LAN sync between depot and driver clients.

This document is the canonical spec. If a behaviour conflicts with this
file, the file wins; the code is wrong and should be changed to match.

---

## 0. Business context (read first)

Counter is being deployed as part of a 12-month restructuring of the family
shop from saturated walk-in wholesaler to a route-based FMCG distributor.
The business plan (`Family_Shop_Restructuring_12_Month_Plan.docx`) is the
source of truth for the operational model; this spec is the source of
truth for the software. Where the two interact (e.g., when do we start the
order-capture extension), the plan governs sequencing and this spec
governs behaviour.

The phasing matters for what gets built when:

| Plan phase | Months | Counter scope |
| ---------- | ------ | ------------- |
| Phase 0 — Settle the past (GRA) | 1–3 | Counter not yet deployed in production. Existing audit-log + day-lock + reprint-queue features are part of the GRA-defensibility argument for the **next** GRA cycle, not the current one. |
| Phase 1 — Quiet legal restructuring (incorporate LLC) | 2–4 | Counter not yet deployed. Schema review for any LLC-specific fields (entity name on receipts, multiple bank accounts) happens here. |
| Phase 2 — Operating model shift (walk-in → route) | 3–6 | Manual order book + spreadsheet only. **Do not start Counter rollout until Phase 2 is stable.** |
| Phase 3 — Brand formalization (sub-distributor pitches) | 4–9 | No Counter changes required. Pricing tiers and per-customer overrides become more useful as anchor-brand margins differentiate from passthrough margins. |
| Phase 4 — Tech layer | 6–12 | Counter rollout in four stages — see Section 18. **This is where new development happens, not before.** |

**Discipline rule:** during Phases 0–2, Counter feature work is frozen.
Bug fixes, verification work, and migration prep continue; new feature
waves do not. The shop needs an operator more than an engineer for the
next 6–9 months, and code is more controllable than business operations,
which makes the temptation to keep building real. Resist it. Counter
ships as-is at start of Phase 4 (month 6); extensions are sequenced from
there.

---

## 1. Stack & runtime model

| Layer | Choice | Why |
| ----- | ------ | --- |
| Shell | **Electron 33** | Single packaged installer; no admin rights to install. |
| Renderer | **React 18 + TypeScript (strict) + Vite** | Fast HMR; the renderer is treated as untrusted (contextIsolation on, nodeIntegration off). |
| Main | **Node 20 + TypeScript** | All DB writes happen in the main process. |
| DB | **better-sqlite3 11** | Synchronous, transactional. WAL journal. Single `counter.db` file in `<userData>`. |
| State | **Zustand** in renderer | Selectors must return primitives, never new object literals (it triggers infinite re-render). |
| Build | **vite-plugin-electron** + **electron-builder** | Cross-platform installer matrix in CI. |

The renderer never touches SQLite. Every read or write goes through an IPC
channel; the main-process handler validates the worker's session, runs the
service function, and returns a serialisable response.

### IPC contract

Every IPC call resolves to one of:

```ts
type IpcResponse<T> =
  | { success: true;  data: T }
  | { success: false; error: string }
```

The renderer wraps `window.counter.*` calls in `humanizeError()` which
rewrites `SQLite3Error: ...` and other internal strings into user-facing
guidance. The wrapper is an explicit object rebuild, not a Proxy
(contextBridge exposes data properties as non-configurable, and Proxy `get`
invariants forbid returning a different value).

---

## 2. Money, units, IDs

- **Money: integer pesewas.** 1 cedi = 100 pesewas. Never floats. Helpers
  in `src/shared/lib/money.ts`: `parseCedisToPesewas`, `formatMoney`,
  `formatMoneyWithCurrency`. Discounts, taxes, payments — all integer math.
- **Phone: `+233XXXXXXXXX`** (12 chars, leading `+`). Enforced by `CHECK
  (phone GLOB '+233[0-9]...')` on every relevant table.
- **IDs: `{prefix}-{uuidv4}`** — `cust-…`, `sale-…`, `sl-…` (sale_line),
  `cm-…` (container_movement), `cpo-…` (customer_price_override), and
  (Section 18) `po-…` (pending_order), `rt-…` (route),
  `da-…` (delivery_attempt). Prefixes make audit logs and DB inspection
  readable.
- **Quantity: integer.** Per-line quantity is in the worker's chosen
  display unit (CRATE, BOTTLE). Stock movements are always in the
  product's canonical unit (typically BOTTLE), with a `source_unit_id`
  pointer for audit. Conversion happens in the sale service:
  `quantityCanonical = quantityDisplay × conversion_factor`.

---

## 3. Schema

All migrations live under `migrations/` and run in lexical order. Migration
runner is `src/main/db/migrations.ts`. Foreign keys are enabled
(`PRAGMA foreign_keys = ON`) on every connection.

### Migration ledger

Implemented (Waves A–F):

| # | File | Purpose |
| --- | ---- | ------- |
| 0001 | `lookup_tables.sql` | `reason_codes` (RECEIVED_FROM_SUPPLIER, BREAKAGE_*, RETURN_FROM_CUSTOMER, etc.), enums. |
| 0002 | `workers.sql` | Workers + roles (CASHIER, SUPERVISOR, OWNER, FOUNDER) + bcrypt-12 PIN hashes. |
| 0003 | `master_data.sql` | locations, suppliers, products, customers. |
| 0004 | `shifts_sales_stock.sql` | shifts, sales, sale_lines, stock_movements, audit_log. |
| 0011 | `pin_attempts.sql` | Rate-limit table + `cash_counts.parent_count_id` for blind-count linkage. |
| 0012 | `sale_extras.sql` | `SALE_VOID_REVERSAL` reason + `device_config.shop_name`/`shop_subtitle`. |
| 0013 | `stocktake.sql` | `stocktake_events` + `stocktake_lines`. |
| 0014 | `pricing_tiers.sql` | Volume-tier prices per (product, channel, unit). |
| 0015 | `units.sql` | `canonical_unit` + `product_units` (display units + factors). |
| 0016 | `customer_channel.sql` | `customers.preferred_channel`. |
| 0017 | `pricing_tiers_unique.sql` | Partial unique index on (product, channel, unit, min_qty) for active rows. |
| 0018 | `sale_lines_fix_fk.sql` | FK repair after units refactor. |
| 0019 | `sale_payments.sql` | Split payments — one row per tender. |
| 0020 | `period_close.sql` | Day-lock table; sealed days reject new writes. |
| 0021 | `petty_cash_expenses.sql` | Till expenses with category enum + supervisor + photo. |
| 0022 | `daily_summary_expenses.sql` | View update for shrinkage/expense math. |
| 0023 | `recovery_codes.sql` | OWNER PIN recovery — bcrypt-hashed `XXXX-XXXX-XXXX-XXXX`. |
| 0024 | `product_count_class.sql` | ABC cycle-counting class on products. |
| 0025 | `customer_price_overrides.sql` | Per-customer hand-shaken pricing. |
| 0026 | `customer_returns.sql` | Customer returns (distinct from sale voids). |
| 0027 | `promotions.sql` | Bonus-unit promotions + `sale_lines.kind` + `applied_promotion_id`. |
| 0028 | `empties_ledger.sql` | `customers.empties_owed_count` + `container_movements`. |

Total implemented: **22 migrations**, numbered 0001–0004 and 0011–0028
(0005–0010 were merged into 0001–0004 during the early-iteration squash).

Planned (Wave G — Section 18):

| # | File | Purpose |
| --- | ---- | ------- |
| 0029 | `pending_orders.sql` | Pending-order entity + status enum + assignment to route. |
| 0030 | `routes.sql` | Routes, route_stops, route_runs. |
| 0031 | `delivery_attempts.sql` | Per-stop delivery confirmation + collected-cash + status. |
| 0032 | `driver_role.sql` | `DRIVER` role added to workers; permission map updated. |

### Core tables (canonical shape)

```sql
products (
  id PK, sku UNIQUE, barcode UNIQUE, name, category,
  pack_size_units, unit_volume_ml,
  is_returnable, bottle_deposit_pesewas,
  cost_price_pesewas,
  walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
  reorder_threshold, reorder_quantity,
  primary_supplier_id FK,
  canonical_unit,
  count_class CHECK IN ('A','B','C') NULL,        -- Wave B.1
  active, audit columns
)

product_units (
  id PK, product_id FK, unit_name,
  conversion_factor CHECK > 0,                    -- canonical units per display unit
  price_pesewas,
  is_purchase_unit, is_sale_unit, display_order,
  active, UNIQUE(product_id, unit_name), audit columns
)

customers (
  id PK, display_name, phone (Ghana format), customer_type,
  credit_limit_pesewas,
  current_balance_pesewas,                        -- cached; reconciled on boot
  preferred_channel CHECK IN ('WALK_IN','WHOLESALE','ROUTE') NULL,
  empties_owed_count CHECK >= 0,                  -- Wave F
  blocked, blocked_reason,
  audit columns
)

sales (
  id PK, shift_id FK, worker_id FK, location_id FK,
  channel, customer_id FK NULL,
  subtotal_pesewas, total_pesewas,
  is_credit, voided, voided_at, voided_by, void_reason,
  payment_method,                                 -- legacy single-tender; sale_payments is truth
  source_pending_order_id FK NULL,                -- Wave G: link back to the order that produced this sale
  created_at, audit columns
)

sale_lines (
  id PK, sale_id FK, product_id FK,
  quantity > 0,
  unit_price_pesewas, unit_cost_pesewas,
  line_total_pesewas, margin_pesewas,
  applied_tier_id FK NULL, applied_unit_id FK NULL,
  kind CHECK IN ('REGULAR','BONUS') DEFAULT 'REGULAR',  -- Wave D
  applied_promotion_id FK NULL,                          -- Wave D
  CHECK (line_total_pesewas = unit_price_pesewas * quantity),
  CHECK (margin_pesewas = (unit_price_pesewas - unit_cost_pesewas) * quantity)
)

sale_payments (
  id PK, sale_id FK, payment_method,
  amount_pesewas > 0, payment_reference, cash_given_pesewas,
  audit columns
)

stock_movements (
  id PK, product_id FK, location_id FK,
  quantity != 0,                                  -- positive = inflow, negative = outflow
  reason_code FK, shift_id FK NULL,
  worker_id FK, supervisor_approval_id FK NULL,
  customer_id FK NULL,                            -- on sales / returns
  source_unit_id FK NULL,                         -- audit pointer for non-canonical entries
  unit_cost_pesewas, total_value_pesewas,
  audit columns
)
```

### Append-only audit_log

`audit_log` is the forensic ledger. Every state-changing service call writes one
row: `worker_id, action, entity_type, entity_id, before_value (JSON),
after_value (JSON), device_id, created_at`. Voids, breakage approvals, PIN
changes, day-lock seals, recovery-code regenerations — all there. There is no
delete or update; only inserts.

In Wave G this expands to capture pending-order, route_run, and driver
events:

- **Order lifecycle:** `PENDING_ORDER_CREATED`, `PENDING_ORDER_ASSIGNED`,
  `PENDING_ORDER_PICKED`, `PENDING_ORDER_CONVERTED_TO_SALE`,
  `PENDING_ORDER_CANCELLED`.
- **Delivery:** `DELIVERY_ATTEMPT_RECORDED`, `DELIVERY_CASH_COLLECTED`.
- **Route runs:** `ROUTE_RUN_OPENED`, `ROUTE_RUN_CLOSED`,
  `ROUTE_RUN_RECONCILED`.
- **Driver auth:** `DRIVER_LOGIN_OK`, `DRIVER_LOGIN_FAILED`,
  `DRIVER_PIN_CHANGED`.

### Day-lock (`period_closes`)

Each (location, calendar date) gets one row when the OWNER seals the day.
Sealed days reject new writes (sales, voids, breakage, customer payments,
stock receipts, expenses) via `assertNotSealed(db, locationId, dateISO,
context)` calls embedded in every relevant service.

A sealed day can be reopened by an OWNER, which writes
`reopened_at` + `reopened_by` to the same row (one reopen ever — the row is
never deleted). The audit log captures both seal and reopen.

In Wave G, day-lock semantics extend to delivery confirmations on a
delivered-on date. A delivery_attempt cannot be back-dated into a sealed
day.

---

## 4. Pricing precedence

When ringing up a sale line, the per-unit price is resolved in this exact
order — the first match wins:

1. **Customer price override** (Wave C.2) — `customer_price_overrides` row
   matching `(customer_id, product_id, unit_id, channel)`. Channel-specific
   beats channel-NULL for the same triple.
2. **Volume tier** (Wave 7) — `pricing_tiers` row matching
   `(product, channel, unit, min_qty)` for the line's canonical quantity.
   Tier may still beat the override when its price is lower (volume break
   wins over hand-shake).
3. **Line input price** — what the cashier typed or what the unit picker
   defaulted to (`product_units.price_pesewas`).

**Discounts** (subtracted from subtotal) require a supervisor PIN above
₵5 absolute or 5 % relative.

The same precedence applies to pending-order line pricing in Wave G. The
price is captured at order-creation time but recomputed at
sale-conversion time — if the customer's tier changed between order and
delivery, the conversion picks the price that was in effect at delivery,
not at order intake. Customer-visible price changes between order and
delivery are surfaced to the depot lead before conversion.

---

## 5. Bonus-unit promotions (Wave D)

A promotion: "buy `qty_buy` of product P, get `qty_get_free` free."

When a sale line ships, the sale service runs `computeBonusLines` over all
regular lines:

- For each line, find active promos matching `(product, unit, channel)`
  and within `valid_from..valid_to`.
- **Greedy on largest qty_buy threshold.** A 12-buy promo is preferred over
  a 6-buy promo; 18 crates fires the 12-buy promo once (3 free), not the
  6-buy promo three times (3 free) — same outcome here, but the rule
  prevents stacking that would over-give.
- The bonus line is inserted into `sale_lines` with
  `kind='BONUS'`, `unit_price_pesewas=0`, `line_total_pesewas=0`,
  `unit_cost_pesewas=real`, `margin = -(cost × qty)`,
  `applied_promotion_id=promo.id`.
- A real `stock_movements` outflow still fires (the goods physically leave
  the shelf).

Daily summary surfaces bonus-unit cost grouped by supplier so the owner
can claim the rebate from Coke / Guinness / etc. — important enough to
note here that this is also how **anchor-brand sub-distributor rebates**
get reconciled in Phase 3 of the business plan.

---

## 6. Customer credit & returns

### Sales on credit and partial payments

Every non-voided sale produces one or more `sale_payments` rows whose
amounts sum to `sales.total_pesewas` — the invariant is enforced in
service code (see `createSale` in `sales.ts`), not by a database
CHECK constraint, because SQLite can't express cross-row sums.

The row shapes that produce a credit-bearing sale:

- **Full credit** (customer takes goods, pays later): one
  `sale_payments` row with `payment_method = 'CREDIT'` and
  `amount_pesewas = total_pesewas`. `sales.is_credit = 1` and
  `sales.payment_method = 'CREDIT'`. The customer's
  `current_balance_pesewas` increments by the CREDIT row's amount.

- **Partial payment** (customer pays some now, owes the rest): one
  row per non-zero tender, plus a CREDIT row for the remainder.
  Example: ₵100 sale, customer hands over ₵60 cash → two rows,
  `CASH ₵60` and `CREDIT ₵40`. `sales.is_credit = 1` and
  `sales.payment_method = 'MIXED'`. The balance increments by the
  CREDIT row's amount (₵40), never by the total. Mixed tenders
  beyond cash + credit are supported by the same shape:
  `CASH + MOMO + CREDIT`, `MOMO + BANK + CREDIT`, etc.

A pure-cash, pure-MoMo, or pure-bank sale produces a single
non-CREDIT row summing to the total and leaves `is_credit = 0`.

**Over-limit gate.** When the projected customer balance
(`current_balance_pesewas + creditRowAmount`) would exceed
`credit_limit_pesewas`, the caller must supply a `supervisorApprovalId`
— a one-shot, time-bounded approval row from
`supervisor_approvals` (migration 0008, service
`supervisorApprovals.ts`). The approval is consumed inside the
sale transaction; a duplicate-completion attempt with the same id
fails. Same pattern is available to other elevated actions
(over-threshold discount, breakage, void) when they're built.

**Voids reverse by CREDIT row, not total.** `voids.ts` decrements
`current_balance_pesewas` by `SUM(sale_payments WHERE
payment_method = 'CREDIT')` for the sale, falling back to
`total_pesewas` only for pre-backfill legacy sales (those with no
`sale_payments` rows at all).

In the route-distribution business model, retailer customers commonly run
on net-7 credit terms; this is the default path, not an exception path.
Phase 2 of the business plan (months 3–6) builds credit policy around 4
weeks of cash-on-delivery for new accounts before credit eligibility.

### Recording payments
`recordCustomerPayment` does FIFO allocation against open credit sales
(oldest first). Excess money becomes an unallocated payment row (store
credit). Every payment writes one `customer_payments` row plus N
`customer_payment_allocations` rows. The customer's cached balance is
recomputed via `reconcileCustomerBalance`.

Aging buckets: 0–30, 31–60, 61–90, 90+. Dashboard surfaces customers in
the 90+ bucket as red.

### Returns from customers (Wave C.3)
Distinct from a void. The customer brings goods back days later.
`customer_returns` is the header (`refund_method ∈ {CASH, CREDIT, STORE}`),
`customer_return_lines` is per-line. For each line, a positive
`RETURN_FROM_CUSTOMER` `stock_movements` row puts goods back on the shelf.

- **CREDIT refund:** synthetic `customer_payments` rows (`payment_method =
  'RETURN_CREDIT'`) with FIFO allocation against open balances. Excess
  becomes store credit.
- **CASH refund:** writes a `cash_counts` row with `count_type='CASH_DROP'`
  and `notes='customer-refund:...'`. Till math handles it like any drop.

Supervisor PIN required regardless of refund method.

In a route context, returns commonly occur at the next delivery visit
("this case had short-dated stock"). The Wave G driver client captures
this as a return record at the route stop, but the actual return entity
is created back at the depot — the driver records intent, the depot
processes the goods.

### Printable customer statement (Wave C.1)
`buildCustomerStatement(customerId, asOfDate?, monthsOfHistory?)` returns
a projection: shop header (name + subtitle + owner phone), customer block
(name/phone/credit limit/blocked flag), aging totals, open invoices
(oldest first), recent payments (newest first within the history window),
and a suggested settle-by date. The renderer mounts it in a modal with
`@media print` rules that hide everything but the statement body.

---

## 7. Empties / returnable container ledger (Wave F)

Two parallel ledgers in one `container_movements` table:

```
kind ∈ {
  CUSTOMER_TAKES_FULL,     -- customer buys returnable: empties_owed_count++
  CUSTOMER_RETURNS_EMPTY,  -- customer brings bottles back: empties_owed_count--
  DEPOT_RECEIVES_FULL,     -- supplier delivers full crates
  DEPOT_RETURNS_EMPTY      -- we send empties to supplier
}
```

A CHECK constraint enforces that customer kinds carry `customer_id` (and
no `supplier_id`) and depot kinds carry `supplier_id` (and no
`customer_id`).

`customers.empties_owed_count` is the cached running balance per customer
(across all returnable products) and has `CHECK (>= 0)` — you cannot
return more bottles than you owe.

The deposit per container is **snapshotted at the time of the movement**
in `deposit_per_container_pesewas`, so even if the product's deposit
changes later, historical refund value stays honest.

Cash refund of a deposit on customer return: writes a `cash_counts`
CASH_DROP row tagged `empties-deposit-refund:<customer>:<product>:<qty>`.

`depotReconciliation(since, until)` computes net empties owed back to each
supplier (fulls received − empties returned).

In Wave G, route-collected empties are posted at delivery confirmation:
each delivery_attempt may include a `collected_empties` count which fires
`CUSTOMER_RETURNS_EMPTY` movements at sale-conversion time. The driver
reports the count; the depot fires the movement on conversion.

---

## 8. Shifts, cash drops, day close

A worker opens a shift with a starting cash count (one row in
`cash_counts` with `count_type='OPENING'`). Every cash sale (via
`sale_payments.payment_method = 'CASH'`) increases the till's expected
cash. Every `count_type='CASH_DROP'` row (drops to owner, supplier, runner,
customer refund) decreases it.

**Closing is two-step blind count.** The cashier types their count first
(`SHIFT_SUBMIT_COUNT`, writes `cash_counts.count_type='COUNTED_BLIND'`).
The system then reveals the expected cash and short/over delta. Closing
the shift seals the count and writes `shifts.closed_at`.

Wave G adds a parallel concept of a **route run** — a rider opens a route
shift, takes assigned pending orders out, returns with collected cash,
and the route shift closes with its own blind count against expected cash
from delivery_attempts. Route shifts do not replace depot shifts; they
coexist. **Route shifts open with zero cash** (the simpler-audit model);
every collected_cash is a discrete addition reconciled at close. There is
no per-driver cash float — see 18.5 for the implication on
`route_runs.opening_cash_count_id`.

---

## 9. Backups (Wave B.2)

`scripts/backup.cjs`:
1. Opens `<userData>/counter.db` and runs `VACUUM INTO <target>/counter-YYYY-MM-DD.db`.
   Falls back to file copy if the bundled `better-sqlite3` binary doesn't load.
2. Recursively copies `<userData>/photos` to `<target>/photos-YYYY-MM-DD/`.
3. Rolling retention — keep the last 14 (configurable via `--keep N`).
4. Writes `<userData>/last_backup.json`:
   `{ timestamp, target, dbDest, usedVacuum, keep }`.

The renderer reads the heartbeat on boot via `BACKUP_GET_HEARTBEAT` and
shows a banner on `HomeScreen` above the action grid:

| Age | Severity | Banner |
| --- | -------- | ------ |
| ≤ 72 h | (none) | not shown |
| > 72 h | warning (amber) | "Last off-site backup: N hours/days ago" |
| > 7 days | danger (red) | "… at risk" with action prompt |
| no heartbeat ever | danger (red) | "No off-site backup yet" |

Dismissible with "Remind tomorrow" — preference stored in `localStorage`
under `counter.backupBanner.dismissedUntil`, expires at 6 am next day.

**Off-site rotation.** USB stick goes home every night. Without an
off-site copy a fire or theft loses everything.

---

## 10. OWNER PIN recovery

If the OWNER forgets their PIN, the only way back in is the recovery code
issued at first-run setup or regenerated later from Settings → Workers.

- Format: `XXXX-XXXX-XXXX-XXXX` (16 alphanumerics, hyphens for legibility).
- Stored as a bcrypt-12 hash on `workers.recovery_code_hash`. Hyphens and
  case stripped before hash compare.
- The plaintext is shown ONCE at issuance — the UI requires the user to
  tick "I have written this down somewhere safe" before the modal closes.
- Recovery flow: from LoginScreen → "Forgot PIN" → pick OWNER → enter code
  → set new PIN. A fresh recovery code is generated as part of the reset
  (the old one is dead).
- Regenerate from Settings → Workers (OWNER-only button) for routine
  rotation; old code dies immediately.

The flow is documented inline in `src/main/services/recovery.ts` and the
audit_log captures both `RECOVERY_CODE_ISSUED` and `OWNER_PIN_RESET`.

---

## 11. Role gates

UI buttons that require elevation (add worker, deactivate worker, manage
price overrides, regenerate recovery code, seal day, reopen day, manage
promotions) are **visible but disabled** for lower roles, with a tooltip
explaining the requirement. Hidden buttons are an antipattern — workers
need to know what exists, who can do it, and who to ask.

The session role is read once via `useSession((s) => s.workerRole)`
(primitive selector — never an object literal).

Wave G adds a `DRIVER` role with explicit narrow permissions (see
Section 18.4). Drivers cannot void sales, modify pricing, write breakage
records, or trigger any non-route service. This is enforced in
`requireDriverOrLikelier()` and audited at every IPC handler.

---

## 12. File / module layout

```
counter/
├── migrations/                    0001..0028 — additive only.
├── scripts/
│   ├── backup.cjs                 nightly backup with VACUUM INTO
│   ├── db-migrate.ts              run pending migrations
│   └── db-reset.ts                drop + re-migrate (dev only)
├── src/
│   ├── shared/
│   │   ├── lib/money.ts           parseCedisToPesewas, formatMoney
│   │   ├── lib/phone.ts           Ghana phone validator
│   │   └── types/ipc.ts           IPC channel constants + req/resp types
│   │                                (single source of truth across processes)
│   ├── main/
│   │   ├── index.ts               Electron entry; opens DB; registers IPC handlers
│   │   ├── preload.ts             contextBridge — exposes window.counter
│   │   ├── db/migrations.ts       runMigrations(db, dir)
│   │   ├── db/seed.ts             dev fixtures
│   │   ├── ipc/handlers.ts        IPC dispatcher; requireWorker / requireOwnerLike;
│   │   │                            registers all session/wave handler groups
│   │   ├── printer/printer.ts     thermal printer adapter (escpos-like) + console fallback
│   │   ├── photo/photo.ts         storage helper (writes under <userData>/photos/...)
│   │   └── services/              (per-feature service module)
│   │       auth, workers, shifts, sales, voids, breakage, consumption,
│   │       stockReceipts, stocktake, cashDrops, dailySummaries,
│   │       productsAdmin, customersAdmin, suppliersAdmin,
│   │       pricingTiers, customerCredit, productUnits,
│   │       reorderSuggestions, periods, exceptionReports,
│   │       expenses, recovery, customerStatement,
│   │       customerPriceOverrides, customerReturns,
│   │       promotions, empties, stockHistory, stockMovements,
│   │       reprintQueue, auditQuery, boot
│   │       (Wave G additions: pendingOrders, routes, routeRuns,
│   │       deliveries, drivers)
│   └── renderer/
│       ├── App.tsx                 router (login → open shift → home → feature screens)
│       ├── lib/ipc.ts              counter wrapper + humanizeError + CounterApi (single
│       │                              `interface CounterApi` merged across the file —
│       │                              fixes the TS2717 cascade, Wave E)
│       ├── store/session.ts        Zustand store — workerId, workerRole, …
│       ├── components/             AppHeader, CashDropModal, ExpenseModal,
│       │                            SupervisorPinModal, RecoveryResetModal,
│       │                            CustomerStatementModal, PriceOverridesModal,
│       │                            CustomerReturnModal, BackupHealthBanner, …
│       ├── screens/                LoginScreen, OpenShiftScreen, HomeScreen,
│       │                            SaleScreen, VoidSaleScreen, BreakageScreen,
│       │                            ConsumptionScreen, StockReceiveScreen,
│       │                            StocktakeScreen, DailySummaryScreen,
│       │                            CustomersScreen, CustomerDetailScreen,
│       │                            SettingsScreen + tabs (Products, Workers,
│       │                              Suppliers, Tiers, Reorder, ReprintQueue,
│       │                              AuditLog, BreakageReview, …)
│       │                            (Wave G additions: PendingOrdersScreen,
│       │                            RouteAssignmentScreen, RouteRunScreen,
│       │                            DriverHomeScreen)
│       └── styles/                 Tailwind config + global CSS
├── tests/                          Vitest — auth, shifts, sales, customer credit,
│                                    products admin, pricing tiers, product units,
│                                    breakage, consumption, daily summaries,
│                                    customers admin, customer statement, …
└── _verify_*.mjs                   Linux/WASM smoke verifications used in CI
```

### Service contract pattern

Every service exports one or more pure-ish functions taking
`(db, input, …)`. They throw `Error` with human-readable messages on
invalid input. The IPC handler catches and wraps in
`{ success: false, error }`. State changes go through `db.transaction(() =>
{ … })()` so partial failures roll back cleanly.

---

## 13. Renderer type architecture (Wave E)

Pre-Wave-E, every feature added a:

```ts
declare global {
  interface Window {
    counter: Window['counter'] & { newMethod: ... }
  }
}
```

block. TypeScript treats each as a redeclaration of `Window.counter` and
emits TS2717 — 60+ errors at peak.

Post-Wave-E:

```ts
declare global {
  interface CounterApi { /* base methods */ }
  interface Window { counter: CounterApi }
}

// later sections augment via declaration merging:
declare global {
  interface CounterApi {
    customerStatement: (...) => Promise<IpcResponse<...>>;
  }
}
```

Single `interface CounterApi` declared in the global scope, augmented by
TypeScript's interface-merging across sections of `src/renderer/lib/ipc.ts`.
TS2717 errors drop to **0**. The remaining ~24 typecheck errors are
pre-existing drift unrelated to the IPC surface (printer dts, regex match
narrowing, sale-screen ProductHit shape).

Wave G adds new sections to the interface (`pendingOrders.*`, `routes.*`,
`deliveries.*`, `drivers.*`) — all declared via the same merging pattern.
The TS2717 floor stays at zero.

---

## 14. Verification & CI

- **Unit tests** (`tests/*.test.ts`) — Vitest + an in-memory better-sqlite3
  DB built from full migrations + dev seed.
- **WASM smoke verifications** (`_verify_*.mjs`) — node-sqlite3-wasm-based
  scripts that exercise SQL queries directly. Used when better-sqlite3's
  native binary doesn't load (CI sandbox, alt-OS dev box).
- **Cross-platform installer** — GitHub Actions matrix
  (`.github/workflows/release.yml`) builds Windows .exe, macOS .dmg, Linux
  .AppImage on every tag push.
- **Pre-commit hygiene:**
  - `npm run typecheck` — `tsc --noEmit`. Wave-E target was zero TS2717.
  - `npm run lint` — eslint w/ `--max-warnings=0`.
  - `npm run test` — Vitest run.
  - `npm run smoke` — runs every `_verify_*.mjs` against a temp DB.

---

## 15. Conventions

- **Comments are for *why*, not what.** The schema and code are
  self-explanatory; every non-obvious decision (pushback fix, race-window
  guard, deliberate non-DRY) is annotated.
- **Migrations are append-only.** Once shipped, never edited.
- **`device_id` everywhere.** Every audit-bearing table carries a
  `device_id TEXT NOT NULL` column. The owner can run multiple counters
  someday and we want to attribute every row.
- **No floating money.** Anywhere money appears as a JS `number`, it is
  pesewas (integer). The boundary where humans enter cedis is
  `parseCedisToPesewas`; the boundary where humans see cedis is
  `formatMoney`. Don't introduce a third.
- **Default deny on permissions.** Every IPC handler calls
  `requireWorker()` first. Admin handlers also call `requireOwnerLike()`.
  Recovery handlers are explicit about being unauthenticated. Driver
  handlers call `requireDriverOrLikelier()`.
- **Append-only audit log.** Every state change writes one row. Never
  delete from `audit_log`. Reading the log is how you debug "what
  happened on Tuesday."
- **Don't optimise prematurely.** SQLite on a single-user POS handles
  millions of rows comfortably. Reach for indexes only when a screen
  visibly stutters.
- **Plan before code.** Wave G builds against the operating-plan phase
  sequencing in Section 0. Don't start a wave's code until its
  business-plan prerequisite is satisfied.

---

## 16. Wave summary (this iteration)

| Wave | Theme | Shipped |
| ---- | ----- | ------- |
| A.1 | Hygiene | Auto-clean `dist-electron` on dev. |
| A.2 | Hygiene | OWNER recovery-code regenerate button. |
| A.3 | Hygiene | Barcode scanner support on SaleScreen. |
| A.4 | Hygiene | Pre-shift-close reprint queue check. |
| B.1 | Operations | Cycle counting — ABC class on stocktake. |
| B.2 | Operations | Off-site backup health indicator. |
| C.1 | Customer | Printable customer statement. |
| C.2 | Customer | Per-customer price overrides. |
| C.3 | Customer | Returns from customers (CASH or CREDIT refund). |
| D | Promotions | Bonus-unit promotions ("buy N get M free"). |
| E | Type cleanup | Consolidated `Window.counter` types — TS2717 from 60+ to 0. |
| F | Empties | Customer + depot empties ledger. |
| **G** | **Route distribution** | **Planned. See Section 18.** |
| **H** | **Customer performance & loyalty** | **Planned (Stage 4B, parallel to Wave G core). See Section 20.** |

Schema state: 22 implemented migrations (0001–0004, 0011–0028).
Planned: Wave G adds 0029–0032 (4 migrations), Wave H adds 0033 (1
migration). Total projected: 27 migrations once both planned waves
ship. (Section 19's voice-intake agent and its companion migration
0034 for an AGENT role were scoped out on 2026-05-11 — see Section 19
for the deferral note. Orders come in by phone and are typed in
manually at the depot under the new operating model.) Total verifier
coverage in this iteration: **67/67 PASS** across 6 new flows
(heartbeat, statement, price overrides, returns, promotions, empties).
Wave H verification target: 12+ assertions per Section 20.11.

---

## 17. Open / future

- **Multi-location.** `customer_payments` is not yet location-tagged;
  uses `DEFAULT_LOCATION_ID` constant. Schema is ready (every table has
  `location_id`); a migration to backfill payments is straightforward.
  Becomes more pressing if the depot ever splits into a primary depot
  plus a secondary holding location.
- **STORE refund method.** `customer_returns.refund_method` accepts
  `'STORE'` at the schema level but the service rejects it until a real
  store-credit ledger exists (currently CREDIT does double duty).
- **Tier-on-bonus interaction.** Bonus lines never go through the tier
  picker because they're priced at zero by definition. Confirmed correct
  with current product owner; revisit if "buy 12 get a discount on the
  13th" comes up.
- **Multi-tenant.** Single device, single shop today. The `device_id`
  audit column was put in early so we can add sync without a forklift
  migration. Wave G stays single-DB at the depot but adds a
  driver-client sync model on top — see 18.6.

---

## 18. Wave G — Route distribution extensions (planned)

This is the section of the spec that turns Counter from a single-counter
back-office into the operating system for a route-based wholesale
distribution business. It is **not yet implemented.** It is planned to
ship in stages aligned with Phase 4 of the operating plan (months 6–12).

### 18.1 Scope and non-goals

In scope for Wave G core (Stage 4B):
- A pending-order entity, distinct from a completed sale, with a lifecycle
  (created → assigned → picked → out-for-delivery → delivered/failed →
  converted_to_sale | cancelled).
- Routes and route-runs: stable customer rotations and per-day instances.
- Per-stop delivery confirmation, on-route cash collection, on-route
  empties collection, on-route return-intent capture.
- DRIVER role with narrow IPC permissions.
- Driver client (separate UI) running on a phone or tablet, syncing to
  the depot DB over LAN.

Out of scope for Wave G entirely:
- Route optimization or auto-routing. Routes are statically defined by
  the depot lead.
- Real-time GPS tracking. Drivers report status at stops, not
  continuously.
- Customer-facing self-service (web/app login). Customers do not log
  into anything.

### 18.2 Stage sequence (Phase 4 of the operating plan)

| Stage | Months | Deliverable |
| ----- | ------ | ----------- |
| 4A | 6–7 | Counter deployed at depot as-is. Workers trained. **No new code.** |
| 4B | 7–9 | Migrations 0029–0030. `pendingOrders` and `routes` services. Manual order entry and route-assignment UI at depot. Convert-to-sale flow. |
| 4D | 9–12+ | Migrations 0031–0032. Driver client. Per-stop delivery confirmation. Route-run shifts and blind cash counts. |

Stages must ship in order. Skipping ahead breaks the discipline rule from
Section 0.

### 18.3 Data model (planned)

```sql
pending_orders (
  id PK,                          -- po-{uuid}
  customer_id FK NOT NULL,
  -- All orders are captured by a human at the depot under the current
  -- operating model. PHONE_CALL is the dominant channel; MANUAL covers
  -- in-person and standing-order top-ups; WHATSAPP_TEXT covers typed
  -- WhatsApp messages the depot lead transcribes. The voice-intake
  -- agent channels (Section 19) were scoped out on 2026-05-11.
  intake_channel CHECK IN ('MANUAL','PHONE_CALL','WHATSAPP_TEXT'),
  intake_worker_id FK,            -- the depot worker who captured the order
  created_at, requested_delivery_date,
  status CHECK IN ('CREATED','ASSIGNED','PICKED','OUT_FOR_DELIVERY',
                   'DELIVERED','FAILED','CONVERTED','CANCELLED'),
  -- Manually flaggable by the depot lead when an order looks off and
  -- they want a second pair of eyes before it goes out — quantity
  -- spike, unfamiliar customer, etc. Always 0 by default.
  requires_review INTEGER NOT NULL DEFAULT 0,
  assigned_route_run_id FK NULL,
  pick_started_at, pick_completed_at,
  conversion_sale_id FK NULL,
  cancel_reason TEXT NULL,
  audit columns
)

pending_order_lines (
  id PK,                          -- pol-{uuid}
  pending_order_id FK,
  product_id FK, unit_id FK, quantity > 0,
  unit_price_pesewas_at_intake,   -- snapshot; recomputed at conversion
  notes TEXT NULL,
  audit columns
)

routes (
  id PK,                          -- rt-{uuid}
  name, weekday_pattern,          -- e.g. 'TUE,FRI'
  active, audit columns
)

route_stops (
  id PK,
  route_id FK, customer_id FK,
  stop_order INTEGER,
  UNIQUE(route_id, customer_id),
  audit columns
)

route_runs (
  id PK,                          -- rrun-{uuid}
  route_id FK, run_date,
  driver_id FK,
  opened_at, closed_at, reconciled_at NULL,
  -- Drivers open with zero cash; collected_cash on each delivery_attempt
  -- is the truth. opening_cash_count_id stays NULL unless we revisit and
  -- introduce a per-driver float (option (a) from the original 18.7
  -- discussion); leave the column NULLable so the future option doesn't
  -- need a migration.
  opening_cash_count_id FK NULL,
  closing_blind_count_id FK,      -- cash_counts.count_type='ROUTE_COUNTED_BLIND'
  status CHECK IN ('OPEN','RETURNING','CLOSED','RECONCILED'),
  audit columns
)

delivery_attempts (
  id PK,                          -- da-{uuid}
  route_run_id FK, pending_order_id FK, customer_id FK,
  attempted_at,
  outcome CHECK IN ('DELIVERED','PARTIAL','REFUSED','MISSED'),
  collected_cash_pesewas DEFAULT 0,
  collected_empties_count DEFAULT 0,
  return_intent_lines JSON NULL,  -- driver-reported intent; depot processes formally
  notes TEXT NULL,
  audit columns
)
```

### 18.4 DRIVER role

Permissions:
- Open a route_run assigned to them
- View pending_orders assigned to their current route_run
- Record delivery_attempts (with outcome, collected_cash, collected_empties)
- Submit closing blind cash count
- Read-only on customer balance and empties owed

Forbidden:
- Anything in `customers.create/update/delete`
- Any pricing modification
- Voids, breakage, consumption, expense entry
- Stock receipts
- Day-lock seal/reopen
- Anything in Settings

Enforcement: `requireDriverOrLikelier(session)` is called at every Wave G
IPC handler. Sessions originating from the driver client are
DRIVER-scoped only. `requireOwnerLike()` continues to gate admin actions.

### 18.5 Lifecycle invariants

- A pending_order is editable only in status `CREATED`. Once assigned to
  a route_run, line edits are forbidden until cancellation.
- A pending_order can be cancelled at any status before `CONVERTED`.
  Cancellation is one-way and audited.
- A delivery_attempt always references a pending_order. There is no
  off-route delivery path.
- Conversion to sale runs at depot, not on driver client. The depot lead
  reviews each `DELIVERED` or `PARTIAL` delivery_attempt and confirms
  conversion. Conversion creates the `sales` + `sale_lines` rows,
  applies pricing precedence, allocates `collected_cash` to
  `sale_payments`, recomputes customer balance, and marks the
  pending_order `CONVERTED`.
- A `MISSED` or `REFUSED` delivery_attempt does not create a sale. The
  pending_order can be re-assigned to a future route_run or cancelled.
- A route_run cannot close while any of its delivery_attempts have
  `outcome IS NULL`. Drivers must explicitly mark every assigned stop.
- **Route_run RECONCILED transition:** a route_run moves from `CLOSED`
  to `RECONCILED` once every `DELIVERED` and `PARTIAL` delivery_attempt
  has either been converted to a sale or explicitly written off, AND
  every `MISSED`/`REFUSED` order has been re-assigned to a future
  route_run or cancelled. Reconciliation is OWNER- or SUPERVISOR-gated
  and writes a `ROUTE_RUN_RECONCILED` audit row. A `RECONCILED`
  route_run is read-only; corrections require an OWNER to reopen it,
  which is audited and time-bounded (same one-reopen-ever rule as
  day-lock).

### 18.6 Sync model (driver client ↔ depot)

The driver client and the depot Counter instance run separate SQLite
databases and synchronise over the local Wi-Fi when the driver is in LAN
range.

**This sync layer does not yet exist in Counter.** It is planned for
Stage 4D and will follow the standard offline-first approach: UDP
broadcast discovery on a fixed port, idempotent push using
`INSERT OR IGNORE` so re-sending a row is a no-op, and FK-safe push
order so a driver-side `delivery_attempt` insert pre-resolves its
`pending_order_id` and `route_run_id` (which the depot pushed down on
assignment).

Driver client is online-first when within LAN range; offline mode buffers
`delivery_attempts` for next-rejoin sync. No internet required.

Drivers do not write to `sales`, `customers`, `pricing_tiers`, or any
master-data table directly. They only write to `delivery_attempts` and
update `pending_orders.status`. The depot is the system of record for
everything else.

### 18.7 Open questions for Wave G

- **Partial deliveries.** When `outcome='PARTIAL'`, do we represent the
  delivered subset as a converted sale and the undelivered subset as a
  new pending_order, or do we discount the original pending_order to
  what was delivered and cancel the undelivered lines? Lean toward the
  first (cleaner audit trail) but defer until real partial cases appear.
- **Return-intent processing.** The driver records intent
  (`return_intent_lines` JSON on delivery_attempt) but the formal
  `customer_returns` entity is created at depot. Lean
  conversion-time so a single review session at depot handles the full
  delivery outcome. If the depot rejects the intent (e.g., the customer
  was wrong about short-dated stock), the rejection is audited and the
  driver is notified on next sync; no `customer_returns` row is created.
- **Per-driver cash float.** The current model has drivers open with
  zero cash and reconcile every collected_cash discretely. If field
  experience shows this is unwieldy (e.g., drivers need change for
  partial-payment customers), `route_runs.opening_cash_count_id` is
  ready for a non-NULL float. Revisit after Stage 4D pilot.

---

## 19. Voice intake agent (deferred — 2026-05-11)

The voice/messaging agent originally specified here (a Twilio-fed
STT + LLM pipeline that captured retailer orders from feature-phone
calls and wrote `pending_orders` rows under an AGENT worker role)
has been scoped out. The decision was made on 2026-05-11. Orders
will be captured manually under the new operating model: a depot
worker (typically the depot lead) answers the phone, listens to the
order, and types it into the `pending_orders` form. The same flow
covers in-person walk-ups and typed WhatsApp messages. The driver
later delivers and collects payment at the doorstep, and the order
is converted to a sale at the depot under the existing Wave G
conversion path (Section 18.5).

What this removes from the build surface: Stage 4C of the operating
plan (months 9–11 of the original phasing); the AGENT worker role
(the planned migration 0034 is unused); the `intake_confidence`
and `intake_recording_path` columns on `pending_orders` (also
removed from Section 18.3); the speculative `requires_review`
semantics tied to low-confidence transcription (the column stays,
but now means "depot lead manually flagged this for review"); the
STT vendor evaluation (19-A); the offline-prototype work (19-B);
the live-deployment guardrails (19-C/D); and the non-deployment
checklist at 19.8.

What this does not change: the rest of Wave G is unaffected.
Pending orders, routes, route runs, delivery attempts, the driver
client, and the conversion flow all stay as specified in Section 18.
Manual phone intake is just another value of `intake_channel`
(`PHONE_CALL`), captured by a human, indistinguishable downstream
from an in-person manual entry.

If the business ever revisits voice/automated intake, the original
agent design lives in git history (commit predating 2026-05-11).
The new sections below would need to be retracted: this section's
stub, the migration-0034 footnote in Section 16's schema state, the
Section 20.3 migration-numbering parenthetical, and the
intake-channel comment in Section 18.3. Nothing else in the spec
depends on this section having a body.

## 20. Wave H — Customer performance & loyalty (planned, Stage 4B)

The piece of the system that turns the customer table from a credit-tracker
into an operational signal. For a route-distribution business, knowing
which retailers are growing, fading, and dormant is the highest-leverage
intelligence the depot has — and it's currently in the depot lead's head,
not on a dashboard.

**Status: planned. Slated for Stage 4B in parallel with Wave G core, since
it touches existing data only (no `pending_orders` dependency).** Owner
remains free to defer Wave H to a later slot if Wave G timelines slip —
Wave H is additive observability, not on the route-rollout critical path.

### 20.1 Scope and non-goals

In scope:
- Per-customer scorecard over an owner-selectable window (30 / 60 / 90 /
  180 / 365 days or a custom range): revenue, margin, order count,
  average order value, and the same metrics for the previous equal-length
  window for trend comparison.
- Order cadence: median days between orders, days since last order, an
  engagement state (`NEW` / `ACTIVE` / `SLIPPING` / `DORMANT`) computed
  from the customer's own historical rhythm.
- Top SKUs per customer in the window — the 5 products that drive most
  of their revenue.
- Top-customers leaderboard on `CustomersScreen`, sortable by revenue,
  margin, or order count over the chosen window, with engagement-state
  badges so slipping customers are visible at a glance.
- Loyalty tiers, both manual and computed, both visible. The OWNER picks
  whichever fits — manual flag for explicit relationship calls,
  computed for the rules-driven default.
- Owner-configurable thresholds for the computed tier (`Settings →
  Loyalty`).

Out of scope:
- Predictive churn ML or any model-driven scoring. The cadence rule is a
  3-bin heuristic against the customer's own median, and that's all.
- Customer-facing loyalty programme (no SMS rewards, no points app, no
  customer self-service).
- Cohort analytics or retention curves. Per-customer only.
- Auto-triggered side-effects from tier changes (no automatic price
  override creation, no automatic promotion sends). Wave H is
  observability; if "VIP gets wholesale tier minus 2 %" is wanted,
  that's a separate wave that wires loyalty tier into
  `customer_price_overrides`.

### 20.2 Stage placement

Wave H ships **inside Stage 4B** (months 7–9 of the operating plan)
alongside the route and pending-order services. The dependency graph is
clean: Wave H reads only from existing tables (`sales`, `sale_lines`,
`customer_payments`, `customer_returns`) plus its own thresholds table.
Nothing in Wave H depends on `pending_orders` or `delivery_attempts`.
This means the two waves can be developed in parallel by different
people without merge pain, and Wave H is shippable even if Wave G
slips.

### 20.3 Data model

Migration **0033** (`loyalty.sql`) — Wave G migrations occupy 0029–0032,
Wave H takes 0033. (Migration 0034 was reserved for an AGENT role
under Section 19; that section was scoped out on 2026-05-11 and the
slot is unused.)

```sql
-- Manual tier on the customer row. NULL = no manual tier; fall back to
-- computed. Owner-only writes; cleared by setting NULL.
ALTER TABLE customers ADD COLUMN loyalty_tier_manual TEXT NULL
  CHECK (loyalty_tier_manual IS NULL OR loyalty_tier_manual IN
    ('VIP','GOLD','SILVER','STANDARD'));
ALTER TABLE customers ADD COLUMN loyalty_tier_manual_set_at TEXT NULL;
ALTER TABLE customers ADD COLUMN loyalty_tier_manual_set_by TEXT NULL
  REFERENCES workers(id);
ALTER TABLE customers ADD COLUMN loyalty_tier_manual_reason TEXT NULL;

-- Owner-configurable thresholds for the COMPUTED tier. First match
-- wins, evaluated in tier-rank order: VIP → GOLD → SILVER → STANDARD.
-- A customer with no matching threshold has a NULL computed tier.
CREATE TABLE loyalty_thresholds (
  id TEXT PRIMARY KEY,                                  -- lt-{uuid}
  tier TEXT NOT NULL CHECK (tier IN ('VIP','GOLD','SILVER','STANDARD')),
  metric TEXT NOT NULL CHECK (metric IN
    ('REVENUE_PESEWAS','MARGIN_PESEWAS','ORDER_COUNT')),
  window_days INTEGER NOT NULL CHECK (window_days > 0),
  min_value INTEGER NOT NULL CHECK (min_value >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  -- audit
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL
);

-- One active threshold per (tier, metric, window_days). The whole point
-- is "VIP = revenue ≥ X over Y days" — duplicates would be ambiguous.
CREATE UNIQUE INDEX idx_loyalty_thresholds_unique_active
  ON loyalty_thresholds(tier, metric, window_days)
  WHERE active = 1;
```

The migration seeds default thresholds so the system has a tier model
from day one without owner configuration:

```
VIP        REVENUE_PESEWAS  90 days  ≥ ₵10,000
GOLD       REVENUE_PESEWAS  90 days  ≥ ₵ 5,000
SILVER     REVENUE_PESEWAS  90 days  ≥ ₵ 2,000
STANDARD   ORDER_COUNT      90 days  ≥ 1
```

Owner can edit these from `Settings → Loyalty` once Wave H ships.

**No new schema for windowed metrics.** The scorecard is a query, not a
materialised view. SQLite handles `SUM ... GROUP BY customer_id` over
365 days of `sale_lines` for hundreds of customers in milliseconds; we
revisit only if a screen visibly stutters (per Section 15).

**No new schema for engagement state.** The cadence calculation is
derived from the customer's own `sales.created_at` series at read time.

### 20.4 Effective tier resolution

Both manual and computed tiers are surfaced to the UI; the *effective*
tier (the one used for badges and any downstream logic) follows this
rule:

```
effective_tier = customer.loyalty_tier_manual ?? computeTierFor(customer)
```

The UI shows both alongside each other on the customer detail screen so
the owner can see why a tier is what it is:

```
Loyalty:  VIP  (manual, set 2026-04-12 by Naj — "Long-standing relationship")
                Computed: GOLD
```

If only the computed tier exists, the UI shows just the computed tier
with no "manual" annotation. If only the manual tier is set on a
customer with insufficient history to compute one, the UI shows manual
with "Computed: insufficient data."

### 20.5 Service interface (planned)

Three new service modules:

```ts
// src/main/services/customerScorecard.ts
export interface ScorecardWindow { startISO: string; endISO: string; days: number }

export interface CustomerScorecard {
  customer: { id: string; displayName: string; phone: string; customerType: string };
  window: ScorecardWindow;
  revenuePesewas: number;
  marginPesewas: number;
  orderCount: number;
  avgOrderPesewas: number;
  // Same metrics for the previous equal-length window:
  previousWindow: { revenuePesewas: number; marginPesewas: number; orderCount: number };
  trend: {
    revenueDeltaPct: number;   // -100 to +∞
    marginDeltaPct: number;
    orderCountDelta: number;   // absolute, not pct
  };
  cadence: {
    medianDaysBetweenOrders: number | null;
    lastOrderDaysAgo: number | null;
    engagementState: 'NEW' | 'ACTIVE' | 'SLIPPING' | 'DORMANT' | null;
  };
  topSkus: Array<{
    productId: string; productName: string;
    quantityCanonical: number; revenuePesewas: number;
  }>;
  loyaltyTier: {
    manual: 'VIP'|'GOLD'|'SILVER'|'STANDARD'|null;
    manualSetAt: string | null;
    manualSetBy: string | null;        // worker_id
    manualSetByName: string | null;    // resolved for display
    manualReason: string | null;
    computed: 'VIP'|'GOLD'|'SILVER'|'STANDARD'|null;
    effective: 'VIP'|'GOLD'|'SILVER'|'STANDARD'|null;  // manual ?? computed
  };
}

buildCustomerScorecard(db: DB, customerId: string, window: ScorecardWindow): CustomerScorecard
```

```ts
// src/main/services/loyaltyTiers.ts
listThresholds(db: DB): ThresholdRow[]
upsertThreshold(db: DB, input: ThresholdUpsertInput, workerId: string, deviceId: string): { id: string }
deactivateThreshold(db: DB, id: string, workerId: string): void
computeTierForCustomer(db: DB, customerId: string, now?: Date): 'VIP'|'GOLD'|'SILVER'|'STANDARD' | null
setManualTier(db: DB, customerId: string, tier: 'VIP'|'GOLD'|'SILVER'|'STANDARD'|null,
              reason: string | null, workerId: string, deviceId: string): void
```

```ts
// src/main/services/customerLeaderboard.ts
export interface LeaderboardRequest {
  window: ScorecardWindow;
  metric: 'REVENUE_PESEWAS' | 'MARGIN_PESEWAS' | 'ORDER_COUNT';
  limit?: number;             // default 50
  includeBlocked?: boolean;   // default false
  channel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE'; // optional filter
}

export interface LeaderboardRow {
  customerId: string; displayName: string; phone: string;
  customerType: string;
  metricValue: number;       // pesewas or count, depending on metric
  orderCount: number;
  lastOrderDaysAgo: number | null;
  engagementState: 'NEW'|'ACTIVE'|'SLIPPING'|'DORMANT'|null;
  effectiveTier: 'VIP'|'GOLD'|'SILVER'|'STANDARD'|null;
  rankInWindow: number;
}

topCustomers(db: DB, req: LeaderboardRequest): LeaderboardRow[]
```

### 20.6 Cadence + engagement-state math

For each customer, take the timestamps of all non-voided sales, ordered.

```
deltas      = [sales[i+1].createdAt - sales[i].createdAt] for i in 0..N-2
medianGap   = median(deltas)         // null if N < 3 (insufficient data)
lastGap     = now - sales[N-1].createdAt
```

Engagement state:

| Condition | State |
| --------- | ----- |
| no sales ever | (no state shown — customer is just a record) |
| first sale within last 30 days, fewer than 3 sales | `NEW` |
| `medianGap` known and `lastGap ≤ 1.5 × medianGap` | `ACTIVE` |
| `medianGap` known and `1.5 × medianGap < lastGap ≤ 3 × medianGap` | `SLIPPING` |
| `medianGap` known and `lastGap > 3 × medianGap`, or `lastGap > 60 days` | `DORMANT` |

The 1.5× / 3× multipliers are chosen so a weekly customer becomes
`SLIPPING` after 10–11 days and `DORMANT` after 21+, while a monthly
customer becomes `SLIPPING` after ~45 days and `DORMANT` after ~90.
That feels right at both cadences without per-cadence config; revisit
after a month of pilot data if it's misclassifying.

### 20.7 UI surfaces

**Customer detail — new "Performance" tab.** Joins the existing tabs
(`open` / `history`) with a window picker at the top:

```
[Last 30 days ▾]  [Last 90 days]  [Last 365 days]  [Custom…]
```

Below the picker:
- Revenue / Margin / Order count headlines, each with the trend pill
  ("+18 % vs prev 90d" green; "-22 % vs prev 90d" red).
- Cadence row: "Last order 8 days ago. Median gap 7 days. **ACTIVE**."
- Top SKUs list (5 rows: name, qty, revenue).
- Loyalty tier card showing both manual and computed, with an
  OWNER-only "Edit tier" button.

**CustomersScreen — new "Top customers" view toggle.** Toggles between
the existing alphabetical list and a leaderboard:

```
View: [All customers]  [Top customers]
Metric: [Revenue ▾]  Window: [Last 90 days ▾]  Show: [☐ blocked]
```

Leaderboard rows show rank, name, metric value, engagement-state badge,
loyalty-tier badge. A `SLIPPING` or `DORMANT` row is amber/red to draw
the eye. Clicking a row drills into the Performance tab on that
customer.

**Settings — new "Loyalty" tab.** OWNER-only. Lists active thresholds
in a table. Each threshold has fields tier / metric / window_days /
min_value / active. Add row, edit row (stays a single row per
tier+metric+window_days via the unique partial index), deactivate row.
Below the table, a "Preview" widget: pick a customer, see what tier
they'd compute to under the current threshold rules.

**EditTierModal (OWNER-only).** Manual-tier write surface. Pick tier
from dropdown (or "Clear manual tier"); optional reason text;
audit-logged as `LOYALTY_TIER_SET` / `LOYALTY_TIER_CLEARED` with
before/after values.

### 20.8 IPC surface

```
LOYALTY_LIST_THRESHOLDS         (any role)
LOYALTY_UPSERT_THRESHOLD        (OWNER)
LOYALTY_DEACTIVATE_THRESHOLD    (OWNER)
LOYALTY_PREVIEW_TIER            (any role; computeTierForCustomer)

CUSTOMER_SCORECARD              (any role)   — { customerId, windowStartISO, windowEndISO }
CUSTOMER_LEADERBOARD            (any role)   — { window, metric, limit?, includeBlocked?, channel? }

CUSTOMER_SET_MANUAL_TIER        (OWNER)      — { customerId, tier|null, reason? }
```

All read endpoints are role-open (any worker can view the dashboard).
Threshold edits and manual-tier writes are OWNER-gated. Audit log
captures every threshold change and every manual-tier write.

### 20.9 Integration with later waves

- **Wave G driver client.** The driver client doesn't need the full
  scorecard, but the engagement-state badge per customer would be
  useful at delivery time ("this retailer is `SLIPPING`, ask if
  anything is wrong"). Trivial addition to the read-only customer
  view drivers already have.
- **Future Wave I (auto-pricing-on-tier).** If field experience shows
  the OWNER manually creating customer price overrides every time a
  tier changes, a future wave wires `loyalty_thresholds` to
  `customer_price_overrides` automatically (e.g. "VIP → wholesale
  tier minus 2 %" rule). Out of scope for Wave H; the data model is
  ready.

### 20.10 Open questions

- **Margin reporting accuracy.** Margin per sale uses
  `sale_lines.margin_pesewas`, which is honest at the per-sale unit
  level. Wave H aggregates this over windows. If the OWNER changes
  cost prices retroactively (via products admin), historical margin
  numbers do not change because each `sale_line.unit_cost_pesewas`
  is a snapshot. That's correct forensic behaviour; flag in the UI
  ("margin is computed using costs at the time of each sale") so
  there's no surprise.
- **Refund handling.** Customer returns reduce stock and refund
  money but currently don't decrement the relevant `sale_lines`.
  Wave H scorecard revenue should subtract `customer_returns`
  totals over the window. Service implementation needs to join
  `customer_returns` to the same window. Document this so reviewers
  don't think it's missed.
- **Bonus-line treatment.** Bonus-unit lines have
  `unit_price_pesewas = 0` so they contribute zero revenue — that's
  correct. They contribute *negative* margin (cost outflow). Wave H
  margin numbers should include this so the view reflects true
  customer profitability after promotional cost.
- **Effective tier downstream.** Section 20.4 defines the rule
  `manual ?? computed`. If a future feature wants to act on the
  effective tier, it should call a single helper rather than
  reimplementing the rule. Add `getEffectiveTier(db, customerId)`
  to `loyaltyTiers.ts` to centralise this.

### 20.11 Verification plan

- WASM smoke (`_verify_loyalty.mjs`):
  - Tier threshold table accepts only allowed tier/metric values
    (CHECK constraints fire on bad input).
  - Unique partial index rejects duplicate active rows on
    (tier, metric, window_days).
  - `computeTierForCustomer` returns the highest-tier match (VIP
    over GOLD when both thresholds are met).
  - `manual ?? computed` resolution fires correctly when both, only
    one, or neither is set.
  - Cadence buckets fire at the right `lastGap / medianGap` ratios.
- Vitest (`tests/customerScorecard.test.ts`):
  - Revenue and margin sum over a window match a hand-computed
    expectation.
  - Trend percentage is correct for "this 90 vs last 90".
  - Top SKUs ranked by revenue, ties broken by quantity.
  - Refunds in the window are subtracted from revenue.
  - Bonus lines contribute negative margin and zero revenue.

Target: 12+ assertions PASS before Wave H is considered shippable.
