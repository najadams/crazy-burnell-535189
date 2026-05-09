# Release procedure

Push the local repo to GitHub, fire the Windows build, install on a real
machine, click through the core flow, then promote to dad. **This file
is a checklist — work through it top-to-bottom.**

## 0. One-time GitHub setup

```bash
# from /Users/a./Projects/counter (this folder)
gh auth status                          # should show you logged in
                                        # if not: gh auth login

gh repo create counter --private --source=. --remote=origin
git push -u origin main
```

If you don't have the `gh` CLI:

```bash
# Create a private repo at https://github.com/new — name it "counter"
git remote add origin git@github.com:<your-username>/counter.git
git branch -M main
git push -u origin main
```

## 1. Trigger the Windows build

Two options. Tag is recommended because it produces both an artifact and
a draft Release.

**Option A — tag a release (preferred):**

```bash
git tag v0.2.0
git push origin v0.2.0
```

**Option B — manual run, no tag:**

GitHub → your `counter` repo → **Actions** tab → **Build Windows installer**
(left sidebar) → **Run workflow** → branch `main` → **Run**.

Either path runs the same job: install deps, typecheck, run tests, build,
package. ~6–10 minutes on a `windows-latest` runner.

## 2. Watch the run + grab the .exe

Actions tab → click the running job → wait for the green check.

Scroll to the bottom of the run page. There's a **Artifacts** section
with `counter-windows-installer`. Click to download a zip; inside is
`Counter-Setup-0.2.0.exe` (or whatever version you tagged).

If you tagged: also check the **Releases** tab. The workflow drafts a
release with the .exe attached. Edit the draft if you want release notes;
publish when you're ready to share the link.

## 3. Install on Windows

Copy `Counter-Setup-0.2.0.exe` to a Windows machine.

Double-click. Windows SmartScreen will block it because the binary isn't
code-signed:

> "Windows protected your PC"
> Microsoft Defender SmartScreen prevented an unrecognized app from starting.
> Running this app might put your PC at risk.

Click **More info** → **Run anyway**. (Code signing costs ~$200/yr from a
CA like Sectigo or DigiCert. Defer until production.)

Pick install location, finish. Counter launches from the Start menu.

## 4. Smoke-test the install (do this BEFORE giving it to dad)

The minimum you have to click through. If any step fails, **don't ship**
— file a bug and let me know.

1. **First-run login.** Login screen shows seed OWNER `Naj` / PIN `1234`.
   Sign in.
2. **Settings → Workers → Change PIN.** Old `1234`, new whatever you want.
   Sign out, sign back in with the new PIN. *If the new PIN works, this
   confirms bcrypt is wired correctly through the native module rebuild.*
3. **Settings → Backup → Pick folder → Backup now.** Confirms the native
   file dialog works and `VACUUM INTO` writes a valid file. Open the
   folder and confirm `counter-YYYY-MM-DD.db` exists, ~100KB.
4. **Open shift** with any opening cash.
5. **Stock → Receive.** Add Coke ×24 @ ₵4.50, Sprite ×12 @ ₵4.50, save.
6. **Stock → On hand.** Both should show 24 / 12 in green.
7. **New sale.** Pick channel = WHOLESALE, customer = Mama Akua, add
   Coke ×6, payment = CREDIT. Complete.
8. **Home recent sales.** Click the Mama Akua sale → SaleDetailModal.
   Click **Print receipt** — your printer dialog should appear with a
   clean receipt preview. Print or cancel.
9. **Customers → Mama Akua → Credit tab.** Open balance ₵42.00,
   1 open sale. Click **Record payment** → ₵20.00 cash → done. Balance
   should drop to ₵22.00; the unpaid sale shows ₵22 outstanding.
10. **Cash drop.** Home → Cash drop → ₵5.00, OWNER_TAKE, "test."
11. **Close shift.** Should reconcile: opening + cash payments − cash
    drops = expected. Counted = your number → see the delta. Even +/-
    the delta is fine; you're testing the math.
12. **Sign out, sign in again.** Confirms session persists across logins.
13. **Quit Counter, relaunch.** Confirms DB persists across app restarts
    (counter.db lives at `%APPDATA%\Counter\counter.db`).

If steps 1–13 all work, you're cleared to install on dad's machine and
let him use it.

## 5. Common things that might fail (and what to do)

- **"This app can't run on your PC"** — the .exe is x64; if dad's machine
  is older 32-bit Windows, the build won't run. Less common now; if it
  comes up, switch electron-builder.yml to also output `ia32`.

- **App opens but Login screen shows "Loading…" forever** — the renderer
  IPC isn't finding the main process handlers. Open DevTools (Ctrl+Shift+I
  in the BrowserWindow) and check the Console. Most likely a path issue
  with how `migrations/` is shipped. Compare against the `extraResources`
  in `electron-builder.yml`.

- **First sale fails with "no such table: stock_movements"** — the
  migrations didn't run. Look at the main-process console output (visible
  on dev runs; in prod check `%APPDATA%\Counter\counter.log` if you've
  added logging). Probably a path-resolution bug in `resolveMigrationsDir`.

- **better-sqlite3 fails to load with "module was compiled against a
  different Node.js version"** — the `postinstall` hook didn't run, so
  the native binary was built for system Node not Electron. CI: confirm
  the workflow's `npm ci` step ran the postinstall (logs say
  `electron-builder install-app-deps`). Locally on your machine: run
  `npm run rebuild-native`.

## 6. Once you're confident — give dad a build

Take the .exe to dad's laptop. Walk him through steps 1–13. Then leave a
copy of this RELEASE.md and the QUICKSTART.md so he has the daily
operating instructions.

**Tell him about the backup discipline.** Without daily off-site backups
the spec's "one fire = whole business gone" risk is real. The current
build has manual backup but no nag — adding the BackupHealthBanner
(red banner on Home if last backup > 72h) is on the queue for the
next wave.

## 7. Subsequent releases

```bash
# After making changes:
git add -A
git commit -m "what changed"
git push

# For a new release:
git tag v0.2.1   # bump per change size
git push origin v0.2.1
```

The workflow runs on every tag; older `Counter-Setup-X.Y.Z.exe`
artifacts stay attached to their respective releases on GitHub.

## What's still missing (next wave)

- **BackupHealthBanner** — auto-nag if last backup > 72h.
- **Edit / deactivate** flows for products, customers, workers.
- **PIN attempt rate-limit** — a few wrong PINs and the worker is locked
  out for N minutes (Section 11 of CLAUDE.md).
- **Receipt thermal-printer support** — current build uses
  window.print() which works on any A4 printer. ESC/POS / thermal
  receipt support is a separate driver.
- **Reorder report** — Stock view flags low / negative; spec section 3
  has reorder fields per product. A "what to order this week" report
  from those is straightforward to add.
- **Periodic stocktake / cycle count UI** — to correct book-vs-actual
  drift over time. Schema's already there in `stocktake_events`
  (migration 0013 in the spec; not yet built).

When you want any of those, ping me — none are heavy.
