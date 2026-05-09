# Counter — Quickstart

Three ways to get a Windows installer for dad. Easiest first.

## 1. GitHub Actions (recommended — no Windows needed)

```bash
# in /Users/a./Projects/counter:
git init
git add .
git commit -m "Counter — initial scaffold"

# create a GitHub repo (gh cli or web), then:
git remote add origin https://github.com/<you>/counter.git
git branch -M main
git push -u origin main

# trigger the build:
git tag v0.1.0
git push origin v0.1.0
```

Tag pushes fire `.github/workflows/build-windows.yml`. The job
typechecks, runs the test suite, builds the renderer + main, then
runs `electron-builder --win --x64`. The result:

- `Counter-Setup-0.1.0.exe` is uploaded as a workflow artifact
  (Actions tab → click the run → "Artifacts" at the bottom).
- A draft Release is created with the .exe attached. Promote it
  to "published" once you've smoke-tested.

## 2. Manual workflow run (no tag, just artifact)

GitHub → Actions → "Build Windows installer" → "Run workflow" → main.
Same artifact under the run, no Release.

## 3. Local build (only works on Windows)

```bash
npm ci
npm run typecheck
npm test
npm run package:win
# → release/0.1.0/Counter-Setup-0.1.0.exe
```

`npm ci`'s `postinstall` rebuilds `better-sqlite3` against Electron's
V8 ABI via `electron-builder install-app-deps`. Without this step the
packaged app crashes on first DB open.

## Running the installer on dad's machine

1. Double-click `Counter-Setup-0.1.0.exe`.
2. Windows SmartScreen will show "Windows protected your PC" because
   the binary isn't code-signed. Click "More info" → "Run anyway."
   (Code signing costs ~$200/yr — defer until production.)
3. Pick install location, finish.
4. Launch Counter from the Start menu.

## First-run (in this exact order)

1. **Sign in** with seed OWNER **Naj** / PIN **1234**.
2. **Settings → Workers → Change PIN.** Don't ship to dad with `1234`.
3. **Settings → Backup.** Pick a folder on a USB stick. Hit "Backup now."
   Repeat at end of every business day; rotate the USB off-site.
4. **Open a shift** with whatever cash is in the till.
5. **Stock → Receive.** The seed inserts products with **zero stock**.
   Until you record what's actually in the depot, every sale will push
   the on-hand number negative. Add a line per product, enter the qty
   you have, enter the cost per unit you paid the supplier, save.
6. **Stock → On hand.** Sanity-check the numbers match the depot.
7. **Settings → Products** to add anything not in the seed catalogue,
   **Settings → Customers** to add retailers.
8. Now you're ready to ring real sales. The flow:
   New sale → pick channel → pick products → pick customer → pick
   payment → take cash → see change.
9. If you ring up a mistake: click the row in **Recent sales** on the
   Home screen → "Void sale" → enter reason. Restores stock +
   reverses credit balance.
10. If owner takes cash mid-shift: **Cash drop** button on Home →
    pick reason (OWNER_TAKE / SUPPLIER_PAYMENT / etc.) → enter amount.
    The closing-shift math will subtract this from expected cash.
11. End of day: **Close shift** → enter counted cash → see the delta.
12. **Backup again** before turning off the laptop.

## Database location

`%APPDATA%\Counter\counter.db` on Windows. Back it up from
`File → ...` once that screen exists, or just copy the file. The DB
is single-file SQLite + WAL.

## What's stubbed vs. real

The 14-month plan in `CLAUDE.md` describes a much larger app than
this scaffold. Today's demo build covers:

| Real | Stubbed |
| --- | --- |
| Login (PIN + bcrypt) + change-PIN flow | Worker add/remove, supervisor PIN gates, OWNER PIN recovery code |
| Open shift / close shift (with blind-count delta) | Day-lock, expenses (separate table), recovery codes |
| Cash drop (mid-shift, 6 reasons, audit-logged) | Petty-cash expense table |
| Ring up a sale (cash / momo / bank / credit) | Returns, breakage, consumption, bonus-unit promotions |
| Void a sale (OWNER-gated, restores stock, reverses credit balance) | Reprint queue, void-reversal flow |
| Cart with channel + customer + cash tendered | Pricing tiers, customer overrides |
| Receive stock from supplier (multi-line, per-line cost snapshot) | Per-line receiving notes / lot tracking, supplier statements |
| Stock on hand view (per product, with low + negative flags) | Per-location filtering, stocktake / cycle-count UI |
| Customers list + leaderboard + scorecard (Wave H) | Statements, customer payments, returns flow |
| Add product / Add customer (OWNER-gated) | Edit / deactivate product or customer |
| Settings: Loyalty / Workers / Products / Customers / Backup | Pricing, Suppliers, Reorder report, Audit-log query, Breakage review |
| Manual backup to USB (VACUUM INTO, OWNER-gated) | Scheduled / nightly backup, photo copy, retention |
| Append-only audit log on every state change | (covers RECEIVED, VOIDED, CASH_DROP, PIN_CHANGED, BACKUP_RUN, etc.) |

Wave G (route distribution), Section 19 (voice agent), and the rest of
Section 20 are post-demo work.
