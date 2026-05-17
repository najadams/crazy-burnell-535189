# Counter — System analysis for a wholesaler's body
**Date:** 2026-05-14 · **Author:** Naj + Claude · **Scope:** read-only audit, no code changes

This is an honest, end-to-end read of the codebase against `CLAUDE.md`,
focused on the two concrete blockers Naj raised (multi-unit product entry,
receipt printing) and the wider question: where is this app friction for a
wholesaler, and where does it already feel like an extension of the body?

The summary up front:

> Several headline features in the spec — multi-unit products, pricing
> tiers, customer price overrides, the empties ledger, the reprint queue,
> petty-cash expenses, daily summaries, breakage, consumption, and the
> thermal-printer adapter — are documented as "shipped" in CLAUDE.md
> Section 16's wave table, but they are **not in the code**. What *is*
> shipped is mostly the Wave-G route-distribution layer (pending orders,
> routes, route runs, delivery attempts) and the Wave-H loyalty layer.
> The foundations those upper waves are supposed to sit on are partly
> missing.

That gap is why Naj can't add CRATE/BOTTLE units to a product, why the
sale-screen quantity input feels coarse, and why a fresh dev install
looks like it "can't print" — printing actually works the moment a
default printer is present, but there's no thermal-printer integration
or shop-name editing, so a wholesaler can't make it theirs.

---

## 1. The two blockers Naj raised

### 1.1 "I can't add units like crate / half-crate / water when creating a product"

**Verdict: Naj is right. The feature does not exist in code.**

What the spec promises (Section 3 of `CLAUDE.md`):
- A `product_units` table with `product_id`, `unit_name`, `conversion_factor`, `price_pesewas`, `is_purchase_unit`, `is_sale_unit`.
- Migration `0015_units.sql`.
- A `productUnits.ts` service.
- Sale-line columns `applied_unit_id` and `applied_tier_id`.
- A unit picker on the Sale screen and a "Add another unit" affordance on the product form.

What is actually in the repo:
- `migrations/0015_stocktake.sql` (different table — cycle counting).
- No `product_units` table anywhere. Migration `0011_pending_orders.sql` even has a comment that says verbatim: *"product_units don't ship yet (planned migration 0015). The FK column is reserved so when units do land, existing rows have a place to point. Nullable in the meantime."*
- No `productUnits.ts` service file.
- `sale_lines` has neither `applied_unit_id` nor `applied_tier_id`.
- `products.canonical_unit` exists (defaults to `BOTTLE`) but is hard-coded in `productsAdmin.createProduct` — the form doesn't even expose it.
- The Add-Product form (`src/renderer/components/SettingsProducts.tsx`) has six price fields (cost / walk-in / wholesale / route / reorder-threshold / reorder-quantity) and zero unit fields. No "Add another unit" button, no conversion-factor input, no per-unit price input.

`src/main/services/productsAdmin.ts` (verbatim):
```ts
INSERT INTO products
  (id, sku, name, category,
   pack_size_units, unit_volume_ml,
   ...
   canonical_unit, count_class, ...)
 VALUES (?, ?, ?, ?, 1, ?, ?, ..., 'BOTTLE', NULL, ...)
```
`pack_size_units` is hard-coded to 1 and `canonical_unit` is hard-coded
to `'BOTTLE'`. There is no path to specify multiple sale units.

**Why this matters for a wholesaler.** A beverage wholesaler thinks in
crates first and bottles second. "Give me three crates and four loose
bottles of Voltic 750" is the natural unit of speech. The current SaleScreen
forces you to think in bottles and type `*24` for every crate, every time,
which is exactly the kind of friction that makes the app feel like a stranger.

### 1.2 "Printing is not working"

**Verdict: the receipt template and print path exist and are correctly wired in `SaleScreen.tsx`. The problem is environmental, not code.**

What is shipped:
- `src/renderer/components/PrintableReceipt.tsx` — a portal-mounted receipt body with shop header, lines, totals, tender breakdown, and a `— REPRINT —` marker.
- `src/renderer/lib/printing.ts` — the data shapes and an audit-log helper.
- `src/renderer/styles/index.css` — `.print-portal` rules under `@media print` that hide `#root` and show the receipt at 80mm thermal width on paper.
- `src/main/ipc/handlers.ts` — `PRINT_LOG` handler logs every print attempt to `audit_log`.
- `device_config` table seeds `'Counter Shop'` / `'Beverage distributor'` as defaults.
- `SaleScreen.tsx` lines ~377–399: immediately after `counter.createSale` returns, it sets `pendingPrint`, which mounts `<PrintableReceipt>`, which calls `window.print()` on mount.

What is **missing** vs the spec:
- No `src/main/printer/printer.ts` thermal-printer adapter. The spec promises `escpos-like` + console fallback; the reality is *only* `window.print()` against the OS default printer.
- No silent / direct-to-thermal path in the main process (`webContents.print({ silent: true })` is the Electron pattern; not used anywhere).
- **No UI to edit shop name / subtitle / owner phone.** `device_config` is seeded and read but never written. Every receipt for every wholesaler will say "Counter Shop / Beverage distributor" until a migration or DevTools edit changes it. For Naj's family business, this is the difference between a real receipt and a demo printout.
- No reprint queue (spec Wave A.4 — referenced multiple places in CLAUDE.md, no migration, no service, no UI).

**Most likely reason printing looks broken on Naj's machine:** in a fresh dev environment with no default printer configured (or with macOS / Linux printing dialog requiring user setup), `window.print()` either opens a print preview that's easy to miss, or silently does nothing. The receipt template *is* there — to confirm, on the dev box, set "Save as PDF" as the default printer and click Complete sale. A receipt PDF should appear.

---

## 2. Spec vs reality — what's actually in the code

CLAUDE.md Section 3 lists 22 implemented migrations (0001–0004 and
0011–0028) plus 0033 for Wave H. The actual repo:

| Migration | Spec claim | Real file | Match? |
| --- | --- | --- | --- |
| 0001 | lookup_tables | lookup_tables | yes |
| 0002 | workers | workers (+ device_config) | yes |
| 0003 | master_data | master_data | yes |
| 0004 | shifts_sales_stock | shifts_sales_stock | yes |
| 0005–0010 | "merged into 0001–0004" | wave_h_prereqs, customer_payments, sale_payments, supervisor_approvals, recovery_code_metadata, period_closes | disagree on what 0005–0010 are |
| 0011 | pin_attempts | pending_orders | no |
| 0012 | sale_extras | routes | no |
| 0013 | stocktake | route_run_closing | no |
| 0014 | pricing_tiers | delivery_attempts | no |
| 0015 | units (the multi-unit table) | stocktake | no — **this is Naj's blocker** |
| 0016 | customer_channel | promotions | no |
| 0017 | pricing_tiers_unique | customer_return_lines | no |
| 0018 | sale_lines_fix_fk | (not present) | no |
| 0019 | sale_payments | (present as 0007) | no — numbering |
| 0020 | period_close | (present as 0010) | no — numbering |
| 0021 | petty_cash_expenses | (not present) | no |
| 0022 | daily_summary_expenses | (not present) | no |
| 0023 | recovery_codes | (present as 0009 metadata only) | no |
| 0024 | product_count_class | (folded into 0003) | effectively yes |
| 0025 | customer_price_overrides | (not present) | no |
| 0026 | customer_returns | (lines table 0017 only) | partial |
| 0027 | promotions | (present as 0016) | numbering, otherwise yes |
| 0028 | empties_ledger | (not present) | no |
| 0033 | loyalty | loyalty | yes |

**Wave table verdict** (CLAUDE.md Section 16):

| Wave | Spec says | Reality |
| --- | --- | --- |
| A.1 dev-hygiene | shipped | not verified, low value |
| A.2 OWNER recovery regenerate | shipped | yes — `recovery.ts` + `RecoveryResetModal.tsx` |
| A.3 Barcode scanner | shipped | **no** — grep for "barcode" returns nothing in the sale path. `products.barcode` column exists but no scanner handler |
| A.4 Pre-close reprint queue | shipped | no reprint_queue table, no UI, no handler |
| B.1 ABC cycle counting | shipped | yes — `count_class` column on products, stocktake service |
| B.2 Backup health indicator | shipped | yes — `BackupHealthBanner.tsx` and backup IPC are present, but the spec'd `scripts/backup.cjs` doesn't exist. Backups are run through `backup.ts` service in the main process instead |
| C.1 Printable customer statement | shipped | yes — `PrintableStatement.tsx` exists and is wired in `CustomerDetailScreen` |
| C.2 Per-customer price overrides | shipped | **no** — no `customer_price_overrides` table, no service, no UI |
| C.3 Customer returns | shipped | partial — `customer_return_lines` exists (0017) but no `customer_returns` header table grep'd; `customerReturns.ts` service exists. Worth verifying end-to-end |
| D Bonus-unit promotions | shipped | yes — `promotions.ts` service, `SettingsPromotions.tsx`, `applied_promotion_id` on sale_lines |
| E TS2717 cleanup | shipped | unverified, not on critical path |
| F Empties ledger | shipped | **no** — no `container_movements` table, no `customers.empties_owed_count`, no service |
| G Route distribution | "planned" | **actually shipped** — pending_orders, routes, route_runs, delivery_attempts all in DB and IPC |
| H Customer performance & loyalty | "planned (parallel to G)" | **actually shipped** — `loyalty_thresholds` + scorecard + leaderboard |

**The most surprising finding:** Wave G and Wave H, which the spec
labels "planned," are actually built. Waves C.2, F, and several of the
pricing-related foundations underneath them are not. The pyramid is
upside down: route-distribution and loyalty depend on accurate per-line
pricing precedence (Section 4 of the spec), which depends on `pricing_tiers`,
`customer_price_overrides`, and `product_units` — none of which exist.

Service-layer gaps (services the spec names but doesn't ship):
`productUnits`, `customerPriceOverrides`, `pricingTiers`,
`reorderSuggestions`, `dailySummaries`, `exceptionReports`,
`customerStatement` (the statement renders client-side, no server service),
`breakage`, `consumption`, `expenses`, `empties`, `reprintQueue`,
plus the thermal-printer and photo adapters.

---

## 3. Inventory ergonomics — what a wholesaler feels

### What's good
- **Search-and-add is keyboard-first.** Type "voltic", hit Enter, line is on the cart. The `*24` suffix to bulk-add is a real shortcut.
- **Reorder threshold + quantity** are first-class fields on the product, even if no service surfaces "what should I reorder today?".
- **Stocktake with ABC cycle counting** is shipped. That's grown-up inventory thinking.
- **Stock movements are forensic.** Every receive, sale, void, breakage is one row in `stock_movements`; on-hand is a `SUM(quantity)`, never cached. Hard to lose track.

### What hurts
1. **Receiving stock has no unit awareness.** `StockScreen` takes "quantity received" + "unit cost per unit." If you receive 50 crates of 24 bottles each, you have to type 1200, which is the bottle count, and the unit cost has to be the per-bottle cost. The owner thinks in cases; the system thinks in bottles. The conversion is on the human, every time, with rounding risk.
2. **No "what should I reorder?" view.** Reorder thresholds and quantities are stored but nothing reads them and shows a daily reorder list. This is the single biggest "I'd reach for this in the morning" view a wholesaler wants.
3. **No supplier-side empties tracking.** Beverage wholesalers receive a load on a deposit basis. Without `container_movements` (Wave F), Naj can't tell at a glance "how many crates do I owe Coke this month?" — the kind of question that costs real money if you can't answer it.
4. **No breakage / consumption screens.** Reason codes for `BREAKAGE_INTERNAL`, `BREAKAGE_DELIVERY`, `CONSUMPTION` are seeded in `0001_lookup_tables.sql`, but there is no service or UI to record breakage or consumption. So those reason codes can only be reached by directly inserting `stock_movements` rows.
5. **No exception report.** "Show me everything that looked weird today" — shrinkage, big-discount approvals, supervisor overrides, off-hours voids — would let the owner trust the system. Not in the code.
6. **No daily summary view.** Day-lock works, but there's no "yesterday at a glance" report.

### What would make it feel like a wholesaler's hands
- Add the `product_units` table + service, *and* surface a unit picker on the Sale screen (default to the customer's preferred unit, with one key to switch). The bones for this are already in pending_orders' reserved `unit_id` column and the spec's Section 3 schema.
- Make stock receipts unit-aware. "Received 50 crates of Coke 1.5L @ ₵180/crate" should be one line, and the service should compute canonical-unit cost from `conversion_factor`.
- Add a "Reorder today" screen that joins `products.reorder_threshold` against `SUM(stock_movements.quantity)` and surfaces overdue SKUs in red.
- Wire `BREAKAGE_INTERNAL` / `CONSUMPTION` into a single "Adjust stock" modal with supervisor PIN gate.

---

## 4. Customer ergonomics — speed at the counter, intelligence in the office

### What's good
- **Customer Detail has Profile / Credit / History / Performance tabs.** Wave H's loyalty scorecard is fully wired and shows engagement state (`ACTIVE` / `SLIPPING` / `DORMANT`), top SKUs, and trend deltas. Genuinely useful.
- **Customer leaderboard view** lets you sort by revenue / margin / order count, with engagement badges. Slipping retailers jump out.
- **Multi-tender payments** (Cash + MoMo + Bank + Credit) with the `sale_payments` table is correctly modeled.
- **Pending orders + routes + deliveries** are end-to-end wired. The route lifecycle (CREATED → ASSIGNED → PICKED → OUT_FOR_DELIVERY → DELIVERED → CONVERTED) is real.
- **Customer statement is printable** via the same portal-print mechanism as the receipt.

### What hurts
1. **No customer price overrides** (Wave C.2 in spec; not in code). For a route business, "Mama's price for Voltic is always ₵2.40, regardless of channel" is the single most common pricing exception, and it doesn't exist.
2. **No volume tier pricing** either. "Buy 10+ crates and the price drops" — also Section-4 spec, not in code.
3. **Pricing precedence chain is a flat lookup.** `priceFor(p, channel)` returns one of three columns and nothing else. A sale to a long-standing retailer at their negotiated rate has to be hand-typed every time.
4. **No barcode scanner** on the Sale screen, despite Wave A.3 claiming shipped. Big speed loss if you ever introduce barcoded SKUs.
5. **Shop name on receipt is unchangeable from the UI.** Every receipt says "Counter Shop / Beverage distributor." Naj needs to be able to set this and the owner phone from `Settings`.
6. **Reprint queue doesn't exist.** When the till runs out of paper mid-shift, there is no "reprint the last N sales" affordance. The spec's pre-close reprint-queue check (A.4) doesn't exist either.
7. **Cash drop UX is a `window.alert` chain.** Shift close uses three native `window.prompt` / `alert` dialogs. Works, but jarring; not how the app behaves elsewhere.

### What would make it feel like an extension of the body
- Ship `customer_price_overrides`. This is the most-asked feature in any route distribution business I've ever seen described, and the spec's Section 4 precedence chain is already exactly right.
- Ship pricing tiers. Same precedence resolver; the per-line price becomes "override → tier → unit default." One service, dozens of UX wins.
- Wire the barcode scanner. The hardware sends keystrokes anyway; the SaleScreen search box just needs to recognise the GTIN format and bypass the search list.
- Add an OWNER-only `Settings → Shop` tab to edit shop name, subtitle, owner phone. Five-line migration (already on the row), thirty-line UI.
- Add a "Reprint last sale" button on HomeScreen's recent-sales list, and a reprint queue check before shift close.

---

## 5. Architecture observations

These are subtle but they shape every future change.

### 5.1 The `Window.counter` types are healthy
The Wave-E cleanup in `src/renderer/lib/ipc.ts` is real — the interface
is declared once and merged across the file. Adding new IPC channels
doesn't reintroduce TS2717.

### 5.2 IPC is split across four files
`handlers.ts` (60 channels), `handlers-min.ts` (stock, voids, cash drops,
admin, backups), `handlers-payments.ts`, `handlers-wave-h.ts`. The split is
historical (Wave-E hygiene + Wave-H feature isolation), but a new
contributor has to know to grep all four. Worth consolidating in a future
hygiene wave.

### 5.3 Idempotent seeding includes the OWNER worker named "Naj"
`src/main/db/seed.ts` creates `Naj` with PIN `1234` if no OWNER exists.
That's fine for dev, but make sure the first-run flow in production
forces a PIN reset before any real sale.

### 5.4 `device_config` is the right level of indirection
There's one row, one device, no multi-tenant complexity. When the second
shop happens, you flip `device_id`. The plumbing is there.

### 5.5 Audit log is doing its job
Every state-changing service writes a row. Voids, returns, recoveries,
period seals, route-run reconciles — all there. Forensic property holds.

### 5.6 `pack_size_units` is a stranded column
It exists on `products`, is always 1, is never read or written outside
the constant in `createProduct`. Either it should become the
conversion-factor anchor when units land, or be dropped.

---

## 6. The Section-0 discipline question

CLAUDE.md Section 0 says feature work is frozen during Phases 0–2 and
should resume at Phase 4 (months 6–12). Today is 2026-05-14. The plan
puts that calendar somewhere mid-Phase 2 (months 3–6).

**The honest reading of this analysis is that the spec describes a Phase-4
finished product and the code is in a mid-Phase-3 partial state.**
Some of the upper-wave features (route distribution, loyalty) shipped
ahead of the foundations they depend on. The discipline rule is being
violated *in both directions*: the supposedly-completed Waves 7 / C.2 / F
aren't done, and Wave G ran ahead of its sequencing.

A clean way to interpret this: treat CLAUDE.md Section 16's wave table
as a wishlist, and use the next plannable window to fill the
foundational gaps (units, tiers, overrides, empties, expenses, daily
summaries) before adding anything else.

---

## 7. Prioritised recommendation list

In order of "make this feel like the wholesaler's body" return on
investment, weighted by implementation cost:

### Tier 1 — do these first
1. **`product_units` table + service + UI.** Unblocks Naj's stated need. Probably 1 migration, 1 service, 2 UI changes (Add-product form, Sale-screen unit picker). Touches `sale_lines` to add `applied_unit_id` (already reserved in pending_orders).
2. **Editable shop config (`Settings → Shop`).** One IPC handler, one form. Makes receipts feel like Naj's business.
3. **Default-printer setup doc + "Save as PDF" fallback messaging.** A small QUICKSTART or HomeScreen banner: "No printer configured? Set one in System Settings, or set 'Save as PDF' as your default."

### Tier 2 — fills the foundational holes the upper waves are riding on
4. **`customer_price_overrides`** (Wave C.2). Single table, two screens, transforms the route business.
5. **`pricing_tiers`** (Wave 7). Pair with #4 — same precedence resolver.
6. **`container_movements` empties ledger** (Wave F). For beverage wholesale, this is reconciliation gold.
7. **Reorder Today screen.** Reads `products.reorder_threshold` and on-hand. One screen, big morning-routine win.

### Tier 3 — feel-of-the-hand polish
8. **Barcode scanner integration on SaleScreen** (Wave A.3).
9. **Reprint queue** + "reprint last sale" button (Wave A.4).
10. **Settings → Shop preview** that shows what the receipt will look like, with the actual shop data.
11. **Breakage + consumption modals** behind a single "Adjust stock" entry point (reason codes are already seeded).
12. **Daily Summary screen** (yesterday at a glance).
13. **Exception report** (weird things that happened today).

### Tier 4 — spec hygiene
14. Update CLAUDE.md Section 16's wave table to reflect reality (Wave C.2, F = not shipped; Wave G, H = shipped). Otherwise future you will trust the wave table again and lose another afternoon.
15. Update the migration ledger in Section 3 to match the actual filenames in `migrations/`.
16. Decide what to do with `pack_size_units` — fold into `product_units.conversion_factor` or drop.

---

## 8. Verification used for this analysis

- `migrations/` directory listed and compared file-by-file to CLAUDE.md Section 3.
- `src/main/services/` directory listed and compared to CLAUDE.md Section 12.
- `src/main/ipc/{handlers,handlers-min,handlers-payments,handlers-wave-h}.ts` grepped for every registered `ipcMain.handle` channel.
- `productsAdmin.ts` and `SettingsProducts.tsx` read in full.
- `PrintableReceipt.tsx`, `printing.ts`, and the print CSS rules read in full.
- `SaleScreen.tsx` print + cart flow read; quantity-suffix parser and unit-picker presence verified.
- `seed.ts` read for first-run state.
- `0001`, `0002`, `0003`, `0004`, `0011`, `0015` migrations read or grepped.
- `pack_size_units`, `product_units`, `pricing_tiers`, `customer_price_overrides`, `container_movements`, `petty_cash_expenses`, `reprint_queue`, `barcode` grepped across the whole codebase.

No code was edited. No migrations were run. This is a read-only audit.
