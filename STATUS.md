# STATUS — Counter codebase reality check

**Last updated: 2026-05-11** (Wave G complete except for the separate-app driver client + LAN sync, plus stocktake / cycle counting, Wave D bonus-unit promotions, and Wave C.3 customer returns shipped)

This document is a snapshot of what is actually shipped in the
codebase, versus what `CLAUDE.md` describes. Read this before trusting
any claim in `CLAUDE.md` about whether a feature exists.

`CLAUDE.md` is the canonical spec — it describes the target system.
Most of it is planned, not shipped. The gap is large enough in places
that treating the spec as a description of reality has caused at least
one incorrect scope estimate in development. The right reading is:
`CLAUDE.md` is the design destination; this file is the current
location.

---

## Migration ledger

Spec Section 3 claims 22 implemented migrations (0001–0004 and
0011–0028). Reality:

```
migrations/
├── 0001_lookup_tables.sql
├── 0002_workers.sql
├── 0003_master_data.sql
├── 0004_shifts_sales_stock.sql
├── 0005_wave_h_prereqs.sql
├── 0006_customer_payments.sql
├── 0007_sale_payments.sql                ← new (2026-05-11)
├── 0008_supervisor_approvals.sql         ← new (2026-05-11)
└── 0033_loyalty.sql
```

Nine migrations. The middle band (0011–0028 in the spec) is still
unshipped — those describe planned features (pin_attempts,
sale_extras, stocktake, pricing_tiers, units, customer_channel,
period_close, petty_cash_expenses, daily_summary_expenses,
recovery_codes, product_count_class, customer_price_overrides,
customer_returns, promotions, empties_ledger). None of those tables
exist. The new 0007 and 0008 migrations occupy the numbering slots
that follow the actually-shipped sequence rather than the spec's
planned (and unused) middle-band numbers.

## What is shipped

**Foundation.** Auth, workers, master data (locations, suppliers,
products, customers), shifts, basic sales, basic stock movements, cash
drops, voids. Services: `auth`, `shifts`, `sales`, `voids`, `products`,
`productsAdmin`, `customers`, `customersAdmin`, `workersAdmin`,
`cashDrops`, `stockReceipts`, `stockHistory`, `salesQuery`,
`auditQuery`. Renderer screens: Login, OpenShift, Home, Sale, Stock,
Customers, CustomerDetail, Settings.

**Customer payments.** Migration 0006. `customerPayments` service
exists with `recordCustomerPayment` doing FIFO allocation against open
credit sales as the spec describes. The `customer_payments` and
`customer_payment_allocations` tables are real. `RecordPaymentModal`
and `CustomerCreditTab` exist in the renderer.

**Wave H (loyalty + scorecard).** Migration 0033. Spec Section 20 is
shipped end to end: `loyaltyTiers`, `customerScorecard`,
`customerLeaderboard` services; `EditTierModal`, `SettingsLoyalty`,
`CustomerLeaderboardView`, `CustomerPerformanceTab` components;
`_verify_loyalty.mjs` smoke script.

**Backup service.** `backup.ts` exists and `SettingsBackup` is in the
renderer. The HomeScreen heartbeat banner described in Section 9 is
not shipped.

**Quantity entry on SaleScreen** (2026-05-10). Direct numeric editing
on cart lines, `*N` / `×N` multiplier suffix in product search,
Enter-to-add. Renderer-only change; no schema impact.

**Part-payment end-to-end** (2026-05-11). Both chunks shipped.

Chunk 1 — schema + service: migrations 0007 (`sale_payments`) and
0008 (`supervisor_approvals`); `sales.ts` rewritten to write one
`sale_payments` row per tender for every sale (full cash, full
credit, or any partial split), preserving the legacy single-tender
input shape for backward compatibility; customer balance now bumps
by the CREDIT-row amount only, never by total;
`supervisorApprovals.ts` provides `verifySupervisorPin` +
`consumeSupervisorApproval` as a reusable purpose-bound,
single-use, time-bounded elevation primitive. Smoke
`_verify_sale_payments.mjs` covers 50 assertions. Backfill script
`scripts/backfill_credit_sale_payments.mjs` writes a CREDIT-method
sale_payments row for every legacy fully-credit sale; safe to
re-run.

Chunk 2 — IPC + UI + spec amendment: IPC channel
`supervisor:verify-pin` and the `verifySupervisorPin` renderer
binding; `SupervisorPinModal` component as the purpose-bound PIN
prompt (reusable across over-limit partials, future
over-threshold discounts, voids, breakage, returns); SaleScreen
rewritten to multi-tender entry — three amount inputs (Cash
given, MoMo, Bank) with optional references, live "Handed over /
Change due / On credit" breakdown, pre-fetched customer
credit-limit context, and an automatic over-limit gate that
opens the SupervisorPinModal and threads the approval id into
`createSale`. `voids.ts` updated to reverse balance by SUM(CREDIT
rows) rather than total, with a defensive fallback to total for
pre-backfill legacy sales. CLAUDE.md Section 6 rewritten to
state the new invariant explicitly (every sale produces
sale_payments rows summing to total; over-limit requires a
supervisor approval) — the previous "or a CREDIT-method row,
depending on UI flow" hedge is gone.

`CustomerSummary` extended with `creditLimitPesewas` so the
renderer can run the over-limit pre-check without a separate
fetch path. `customers.ts` SELECT updated to populate it.
Typecheck clean; both smoke scripts (50 + 33 assertions) pass.

**Printing infrastructure** (2026-05-11). System-print-dialog
implementation of two print moments: (1) receipt printed
automatically when a sale completes, showing shop header, date,
cashier, customer, lines, tender breakdown, change due, and the
sale id; (2) customer statement printable on demand from
CustomerDetailScreen with open invoices, recent payments, credit
limit, and current balance. Both render an 80mm-thermal-friendly
HTML template into a hidden iframe and call window.print(), so the
user picks any USB/network printer the OS knows about or
print-to-PDF as a fallback. Every print attempt writes an
audit_log row (`RECEIPT_PRINTED` / `STATEMENT_PRINTED` /
`REPRINT_RECEIPT`).

The renderer-side `lib/printing.ts` module is the contract;
calling screens (`SaleScreen`, `CustomerDetailScreen`) import
`printReceipt` / `printStatement` from it. When a thermal-printer
driver lands, swap the implementation of those two functions to
dispatch ESC/POS via a main-side IPC adapter — the calling
screens and the audit-log step don't change.

**OWNER PIN recovery** (2026-05-11). Spec Section 10 shipped end
to end. Migration 0009 adds `recovery_code_issued_at` +
`recovery_code_issued_by` metadata to workers (the
`recovery_code_hash` column was already declared in 0002).
Service `recovery.ts` generates 16-character codes
(`XXXX-XXXX-XXXX-XXXX`, alphabet excludes confusing O/0/I/1),
bcrypt-12 hashes them, normalises hyphens/case/spaces on compare,
rotates the code on every successful use so a code is single-use
by construction. Three IPC channels: `recovery:list-eligible`
(unauthenticated; surfaces OWNER/FOUNDER workers for the picker),
`recovery:verify-and-reset` (unauthenticated; the "Forgot PIN"
flow), `recovery:regenerate` (OWNER-only; the Settings flow).
Two renderer modals: `RecoveryResetModal` (the full forgot-PIN
wizard) and `RecoveryIssuedModal` (shows the plaintext code ONCE
with the "I have written this down somewhere safe" checkbox-gate
before close). LoginScreen has a "Forgot PIN?" link; Settings →
Workers has a "Regenerate recovery code" button (visible-but-
disabled for non-OWNER roles, per Section 11). Smoke
`_verify_recovery.mjs` covers 19 assertions including code
format, normalisation, single-use, replay rejection, non-OWNER
rejection, and the "no code on file" error path.

**First-run requirement.** Before the depot goes live, the OWNER
must visit Settings → Workers and tap "Regenerate recovery code"
once to get the initial code on paper. Without it, the "Forgot
PIN" flow surfaces "No recovery code on file" — recoverable only
by direct DB inspection. This is a one-time step on the
go-live checklist.

**SaleDetailModal print fix** (2026-05-11). The "Print receipt"
button in Recent Sales used to toggle `body.printing-receipt` and
call `window.print()` — but the same CSS rule that hides `#root`
also hid the modal, so the printed page was blank. Refactored to
use the same `PrintableReceipt` portal as the auto-print flow,
with `reprint=true` so the receipt is clearly marked. Also
extended `getSaleById` (and its IPC response type) to return a
`paymentBreakdown` summing CASH/MOMO/BANK/CREDIT amounts +
change from the sale_payments rows — so reprints show the real
per-method breakdown, not just the total.

**Backup heartbeat banner** (2026-05-11). Spec Section 9.
`runBackup` now writes `<userData>/last_backup.json` after every
successful backup; new IPC channel `backup:get-heartbeat`
exposes it to the renderer. `BackupHealthBanner` component on
HomeScreen surfaces three states: silent (≤72 h since last
backup), warning amber (72 h – 7 days), danger red (>7 days or
never). Dismissible with "Remind tomorrow" — preference stored
in localStorage at `counter.backupBanner.dismissedUntil`,
expires at 06:00 the next morning so the OWNER sees the
reminder when they open the shop.

**Day-lock / period-close** (2026-05-11). Spec Section 3
migration 0020 (shipped as 0010 in our numbering) + Section 8.
Migration `0010_period_closes.sql` adds the `period_closes`
table (one row per location-date with `UNIQUE(location_id,
date)`); service `periods.ts` provides `sealDay`, `reopenDay`
(one-shot per row), `isSealed`, and `assertNotSealed`. The four
critical write paths now call `assertNotSealed` inside their
transactions: `createSale` checks today at the sale's location,
`voidSale` checks the original sale's date (because voiding
changes that day's totals), `recordCashDrop` checks today at
the shift's location, `recordCustomerPayment` checks today at
the shift's location when a shift is attached (after-hours
MoMo/bank notifications skip the gate by design). IPC channels
`periods:seal-day`, `periods:reopen-day`, `periods:list`
(OWNER-gated for write, any-role for list). Settings → Day
close panel shows today's seal state with one-tap seal, lists
recent seals, and offers reopen with a required reason.
`_verify_periods.mjs` smoke covers 23 assertions including
duplicate-seal rejection, future-date rejection, one-shot
reopen, and ISO/YYYY-MM-DD date normalisation.

**Recovery handler registration fix** (2026-05-11). While
adding the day-lock IPC, discovered that the recovery handlers
(`recovery:list-eligible`, `recovery:verify-and-reset`,
`recovery:regenerate`) had never actually been registered in
`handlers.ts` — the original chunk-2 Python edit had silently
no-op'd. The channels were declared, the renderer wrappers
existed, but no main-process listener was bound. The "Forgot
PIN" and "Regenerate recovery code" flows would have hung
indefinitely in the live app. Now correctly registered. Audit
sweep also found multiple bridge methods missing from
`preload.ts` (`verifySupervisorPin`, `logPrint`, all recovery,
all period methods) for the same reason — all now added.

**Wave G pending-orders MVP** (2026-05-11). Stage 4B path per
the operating plan. Migration `0011_pending_orders.sql` adds the
`pending_orders` + `pending_order_lines` tables (status enum
carries all eight lifecycle states from CREATED through
CONVERTED/CANCELLED; voice-intake-related columns omitted per
Section 19 deferral). Service `pendingOrders.ts` provides
`createPendingOrder`, `listPendingOrders` (with `status` filter
including `'OPEN'` and `'CLOSED'` pseudo-values),
`getPendingOrder`, `updatePendingOrderLines` (CREATED only),
`cancelPendingOrder`, and `convertToSale` — which delegates to
`sales.createSale` so multi-tender + supervisor-PIN gate + audit
trail all reuse the existing infrastructure. IPC channels
`pending-orders:create/list/get/cancel/convert`. UI ships as
new `PendingOrdersScreen` (accessible from HomeScreen → Orders),
with `NewPendingOrderModal` for intake (customer picker, channel
selector, product search + line builder, requires-review flag)
and `ConvertOrderModal` for the depot-side convert-to-sale flow
(multi-tender entry on top of the captured lines, with the
over-limit supervisor-PIN gate reused from SaleScreen).
`_verify_pending_orders.mjs` smoke covers 38 assertions
including schema, status transitions, cancel-twice rejection,
convert-after-cancel rejection, requires_review persistence,
OPEN/CLOSED filter behaviour.

This is the **Stage 4B foundation** of route distribution.

**Wave G routes management** (2026-05-11). Migration
`0012_routes.sql` adds the `routes`, `route_stops`, and
`route_runs` tables per Section 18.3 (all three at once so a
follow-up migration isn't needed when the route_run lifecycle
lands). Service `routes.ts` covers route CRUD + stop
management: `createRoute` (with weekday pattern validation —
MON/TUE/.../SUN allowed; empty for ad-hoc), `listRoutes`,
`archiveRoute` / `reactivateRoute`, `listStopsForRoute`,
`addStop` (dense 1..N append), `removeStop` (renumbers the
survivors), `reorderStops` (validates the new order is a
permutation of the current stops). IPC channels under
`routes:*`. Settings → Routes tab: two-pane UI with list +
create-form on the left, selected route's stops with up/down
reorder and remove buttons on the right; OWNER-only writes,
visible-but-disabled affordances for lower roles per
Section 11. `_verify_routes.mjs` smoke covers 35 assertions
across schema, weekday validation, stop reorder, archive
semantics, and `route_runs` schema (status enum, run_date
length, UNIQUE per-route-per-date).

**Wave G route-run lifecycle** (2026-05-11). Migration
`0013_route_run_closing.sql` adds `closing_cash_pesewas`,
`closed_by`, `reconciled_by`, `reconciliation_notes` plus the
reopen trio (`reopened_at`/`reopened_by`/`reopen_reason`) to
the route_runs table — the cash_counts table couldn't host the
blind cash count without weakening its NOT NULL shift_id
constraint. Service `routeRuns.ts` covers open/list/get/assign/
unassign/close/reconcile/reopen. The lifecycle:
  OPEN — depot lead opened the run for a route + driver.
         Pending orders can be assigned (status CREATED →
         ASSIGNED) and unassigned (back to CREATED) freely.
  CLOSED — driver returned, closing cash recorded. Orders
           still need to be converted to sales. Unassignment
           is no longer allowed.
  RECONCILED — every assigned order is in CONVERTED or
               CANCELLED. OWNER/SUPERVISOR-gated; reopen
               blocked permanently from here.
The reopen path (CLOSED → OPEN) is one-shot per row, OWNER-
gated, requires a reason; same shape as day-lock reopen.

IPC channels under `route-runs:*`. UI: new `RouteRunsScreen`
(HomeScreen → "Route runs") with two-pane list/detail layout,
"Open run" modal and "Close run" modal with blind cash entry,
inline reconcile and reopen buttons (role-gated). The Orders
screen now offers an "Assign…" dropdown per CREATED order
listing currently-open runs; ASSIGNED orders get an
"Unassign" affordance. Run detail shows assigned orders with
status. `_verify_route_runs.mjs` smoke covers 30 assertions
including the full state machine, reconcile blocked while
orders in flight, reopen one-shot, archived-route rejection
on open, inactive-driver rejection.

**Wave G delivery_attempts** (2026-05-11). Migration
`0014_delivery_attempts.sql` does two things: (1) adds DRIVER
to `workers.role` via the SQLite table-rebuild dance with
`defer_foreign_keys` so the many FKs pointing at workers
survive, (2) creates the `delivery_attempts` table per
Section 18.3 — one row per pending_order with outcome
(DELIVERED/PARTIAL/REFUSED/MISSED), collected_cash,
collected_empties, return_intent JSON, notes.
`UNIQUE(pending_order_id)` means re-recording for the same
order updates rather than appending; the service does an
upsert.

Service `deliveryAttempts.ts` enforces: order must be assigned
to the named run; run must not be RECONCILED; MISSED and
REFUSED can't carry cash or empties. IPC channels under
`deliveries:*`. UI: from RouteRunsScreen run detail, each
assigned order gets a "Log delivery" button that opens
`LogDeliveryModal` (outcome selector, cash entry, empties
count, notes; pre-fills if a record already exists). Once
recorded, the button shows the outcome label. Hidden when the
run is RECONCILED. `_verify_delivery_attempts.mjs` smoke covers
22 assertions including schema, the role-enum rebuild
preserving existing workers, outcome whitelist, upsert path,
and the MISSED-with-cash service rejection.

**Wave G in-app driver UI** (2026-05-11). `WorkerRole` type
now includes DRIVER (matching migration 0014's schema change).
`requireDriverOrLikelier` helper added to handlers.ts. New
service function `listRunsForDriver` + IPC channel
`route-runs:my-open` returns the logged-in driver's currently
OPEN/RETURNING route_runs. `DriverHomeScreen` is the
touch-friendly per-stop logging UI — large tappable cards
per assigned order, status colouring (DELIVERED green,
PARTIAL amber, REFUSED/MISSED red), all-stops-logged banner
when complete. Reuses `LogDeliveryModal`. App.tsx routes
DRIVER-role workers to this screen instead of HomeScreen on
sign-in. They sign out from the same screen header.

**Chunk 4d separate-app + LAN sync remains deferred.**
The Section 18.6 plan calls for a stand-alone driver build
running on the driver's own device, syncing to the depot
over Wi-Fi (UDP broadcast discovery, idempotent
INSERT-OR-IGNORE push, offline buffer). That's a different
shape of work — separate Electron entry point, network
protocol, offline state — and it's hardware-gated on
provisioning driver tablets and the depot Wi-Fi setup. When
that hardware lands, the current in-app driver UI is the
template; the schema, services, IPC, and UI components all
transplant as-is. The only addition is the sync layer.

## What is NOT shipped (despite spec language)

**Supervisor PIN gate beyond over-limit partials.** The IPC channel
and modal exist (chunk 2 of part-payment), but no other elevated
flow calls into them yet. Discounts-over-threshold (Section 4),
breakage approval, customer returns, and the void path are still
ungated. Adding any one of those is now a small change: import
`SupervisorPinModal`, set `purpose` accordingly, thread the
returned `approvalId` into the service call. The
`requireDriverOrLikelier()`-style role gates also remain unshipped.

**Stocktake, breakage, consumption, pricing tiers, product units,
customer price overrides, customer returns, promotions, empties
ledger, petty cash expenses, reprint queue, exception reports, daily
summaries, statement printing.** None of these features are shipped.
Spec Sections 5 (promotions), 6 (statements + returns), 7 (empties),
portions of 8 (closing two-step blind count), and most of the wave
summary in Section 16 (Waves A.1–A.4, B.1, C.1–C.3, D, F) describe
features that don't have corresponding code.

**Wave G chunks 3–4 (routes, route_runs, delivery_attempts,
driver client, LAN sync).** Section 18 + Section 19 voice-agent
piece. Chunk 1+2 (pending-orders MVP) shipped today; chunks 3–4
remain planned. The depot-only workflow doesn't need them — they
unlock the structured route-management view and the
driver-client side. Section 19 voice agent stays scoped out per
the 2026-05-11 decision.

## Implications for development

The Section 0 discipline rule still applies — Counter feature work is
meant to be frozen through Phases 0–2 of the business plan. Most of
Sections 4–16 in `CLAUDE.md` describes features that need to be built
before Counter is the system the spec implies. Pre-deployment polish
work (like the May 2026 quantity-entry and part-payment changes) is
the right kind of work for this window — it tightens what's there
without committing to new waves.

When picking work, the safe checks are: (a) does the relevant
migration file actually exist under `migrations/`? (b) does the
service file exist under `src/main/services/`? (c) does the component
or screen exist under `src/renderer/`? If any of those is missing, the
feature is planned, not shipped, regardless of what `CLAUDE.md` says.

When new work ships, this file should be updated alongside it.

**Stocktake / cycle counting** (2026-05-11). Migration
`0015_stocktake.sql` adds `stocktake_events` (one per count
session) and `stocktake_lines` (per-product counted vs
expected, with a `GENERATED ALWAYS AS STORED` `delta_qty`
column). The migration also rebuilds `supervisor_approvals` to
add `STOCKTAKE_LARGE_DELTA` to the purpose enum. Service
`stocktake.ts` provides openStocktake (one OPEN session per
location at a time), recordCount (upsert per product;
snapshots expected qty from the stock_movements sum at the
moment of recording), listStocktakeEvents / listLinesForStocktake,
closeStocktake (writes STOCKTAKE_ADJUSTMENT stock_movements
for every non-zero delta; gated on supervisor approval if any
|delta| > 10 units), cancelStocktake (one-way, requires
reason). IPC channels under `stocktake:*`. UI: new
`StocktakeScreen` reachable from HomeScreen → Stocktake.
Two-pane layout — session list on the left, live count entry
on the right. Counted lines show expected/counted/delta with
colour cues (green positive, red negative, ⚠ over threshold).
Close prompts the supervisor PIN modal when needed. Recording
and listing accept any-role; open/close/cancel are
OWNER/FOUNDER. `_verify_stocktake.mjs` smoke covers 29
assertions including schema, generated delta column,
UNIQUE(event, product), state machine, adjustment math.

**Wave D — bonus-unit promotions** (2026-05-11). Migration
`0016_promotions.sql` adds the promotions table per Section 5
(`product_id`, optional `channel`, `qty_buy`, `qty_get_free`,
validity window, active flag). The sale_lines `kind` +
`applied_promotion_id` columns were already in migration 0004,
so the wiring is just service-layer. Service `promotions.ts`:
CRUD + `computeBonusLines` with the greedy-on-largest-qty_buy
algorithm — 18 crates with a 12-buy promo fires the 12-buy
once (1 free × multiplier 1); 48 crates with the same 12-buy
fires it 4 times. `createSale` calls `computeBonusLines` after
the regular lines are written and emits BONUS sale_lines
(unit_price=0, real unit_cost, margin = -(cost × qty),
applied_promotion_id set) plus matching stock_movements
outflows. IPC channels under `promotions:*`. New Settings →
Promotions tab for CRUD; OWNER-only writes, list visible to
all signed-in workers. `_verify_promotions.mjs` smoke covers
28 assertions including the greedy algorithm, channel
scoping, validity windows, archive semantics, schema CHECKs.

**Wave C.3 — customer returns** (2026-05-11). Migration
`0017_customer_return_lines.sql` extends the existing
`customer_returns` header (added in 0005 as a Wave H pre-req)
with `supervisor_approval_id`, `shift_id`, `location_id`, and
adds the `customer_return_lines` table with a CHECK that
`line_total = quantity * refund_unit`. Service
`customerReturns.ts` provides `recordCustomerReturn`:
validates lines + supervisor approval + day-lock, writes
header + lines + positive `RETURN_FROM_CUSTOMER`
stock_movements, then handles the refund path:
  - CASH: writes a `cash_counts` `CASH_DROP` row tagged
    `customer-refund:<customerId>:<returnId>` so the till
    math accounts for the money leaving.
  - CREDIT: writes a synthetic `customer_payments` row with
    `payment_method='RETURN_CREDIT'`, runs FIFO allocation
    against open credit sales, and reconciles the customer
    balance via the existing payment service.
  - STORE: explicitly rejected — Section 17's open question
    notes a real store-credit ledger is needed first; CREDIT
    does double duty until then.
Supervisor PIN gate mandatory regardless of method (Section
6). IPC channels under `customer-returns:*`. UI: "Record
return" button on CustomerDetailScreen header (visible-but-
disabled if no customer loaded) opens
`RecordCustomerReturnModal` — product picker, line entry with
custom refund prices, method toggle (CASH/CREDIT),
SupervisorPinModal gate (purpose CUSTOMER_RETURN). Success
refreshes the customer record. `_verify_customer_returns.mjs`
smoke covers 28 assertions including schema CHECKs, both
refund paths, approval consume-once, STORE rejection,
empty-lines and zero-total rejections.

## Decided against (do not rebuild)

**Voice-intake agent (CLAUDE.md Section 19).** Scoped out on
2026-05-11. The original plan was a Twilio + STT + LLM pipeline
writing `pending_orders` under a synthetic AGENT worker role; the
new operating model is manual phone pickup by a depot worker who
types the order into the `pending_orders` form. Concretely this
removes from the build surface: Stage 4C of the operating plan;
the AGENT role and its migration (planned 0034 — slot is unused);
the `intake_confidence` and `intake_recording_path` columns on the
planned `pending_orders` table; the STT vendor pilot; the
non-deployment guardrails at 19.8. The rest of Wave G is
unaffected — pending orders, routes, route runs, and the driver
client all stay in scope, just fed by human typing rather than a
voice agent.

If a future operator reconsiders this, the original design lives
in git history (commit predating 2026-05-11). Don't re-derive it
from a system-prompt copy of the spec; that copy may also have
been edited.

## Pending work captured but not built

**Pick-ticket printing.** Receipt and statement printing are now
shipped; pick-ticket (a proforma printed mid-sale before payment
so warehouse staff can start pulling) remains deferred until
post-deployment so the workflow can be observed before being
built against. When the time comes it's a third print template
on top of the existing `lib/printing.ts` infrastructure — same
audit-log contract, different rendered body, marked clearly as
NOT A RECEIPT.

**Thermal-printer driver.** The system-print-dialog path ships
today and works with any printer the OS knows about. A
direct-thermal (USB ESC/POS) driver would skip the OS dialog for
one-tap silent printing. Plug-and-play swap when the owner buys
a confirmed thermal printer — the renderer-side contract
(`printReceipt`/`printStatement`) stays the same.
