# Wave H integration notes

This bundle is drop-in code for the Wave H services described in
Section 20 of CLAUDE.md. The migration + verifier already exist
(`migrations/0033_loyalty.sql` and `_verify_loyalty.mjs`, 33/33 PASS).
This document explains what to copy where in the real Counter project
when you locate it.

## Files in this bundle

| File | Goes to | Notes |
| --- | --- | --- |
| `migrations/0033_loyalty.sql` | `migrations/` | Already correctly placed. |
| `src/main/services/loyaltyTiers.ts` | `src/main/services/` | New file. |
| `src/main/services/customerScorecard.ts` | `src/main/services/` | New file. |
| `src/main/services/customerLeaderboard.ts` | `src/main/services/` | New file. |
| `src/shared/types/ipc-wave-h.ts` | merge into `src/shared/types/ipc.ts` | Append the channel constants and request/response types; delete the wrapper file once merged. |
| `src/main/ipc/handlers-wave-h.ts` | merge into `src/main/ipc/handlers.ts` | Add `registerWaveHHandlers` to the existing handler-registration list, called from `src/main/index.ts`. |
| `src/main/preload-wave-h.ts` | merge into `src/main/preload.ts` | Spread `waveHPreload` into the api object exposed to `window.counter`. |
| `src/renderer/components/CustomerPerformanceTab.tsx` | `src/renderer/components/` | New file. |
| `src/renderer/components/CustomerLeaderboardView.tsx` | `src/renderer/components/` | New file. Top-customers ranked view. |
| `CUSTOMERS_SCREEN_INTEGRATION.md` | (docs only) | Patch sketch for wiring the leaderboard into the existing CustomersScreen. |

## Wiring steps in the real codebase

1. **Apply migration 0033.** Drop `0033_loyalty.sql` next to the other
   migrations; run `npm run db:migrate`. The migration is purely
   structural (no seed). Run `_verify_loyalty.mjs` against the migrated
   DB; expect 33/33 PASS.

2. **Seed default thresholds at first-run.** The setup wizard already
   creates the OWNER row. After that completes, call
   `ensureLoyaltyDefaults(db, ownerWorkerId, deviceId)` from
   `src/main/services/loyaltyTiers.ts`. The natural place is whatever
   service the wizard calls last (probably `setup.ts` or `boot.ts`);
   add the call right after the OWNER insert.

3. **Merge IPC types** from `src/shared/types/ipc-wave-h.ts` into the
   bottom of `src/shared/types/ipc.ts`. The `IPC_CHANNELS_LOYALTY`
   const becomes a peer of the existing `IPC_CHANNELS_*` blocks; the
   request/response interfaces become peers of the rest. The
   `declare global { interface CounterApi { ... } }` block follows
   the Wave E declaration-merging pattern (Section 13).

4. **Register handlers** by adding `registerWaveHHandlers(ipcMain, db,
   deviceId, { wrap, requireWorker, requireOwnerLike })` to the
   handler-registration list in `src/main/index.ts`. Existing helpers
   (`wrap`, `requireWorker`, `requireOwnerLike`) are imported from
   `src/main/ipc/handlers.ts`.

5. **Expose preload methods** by spreading `waveHPreload` into the
   `api` object in `src/main/preload.ts`:
   ```ts
   const api = {
     // ...existing...
     ...waveHPreload,
   };
   ```

6. **Mount the Performance tab** on `CustomerDetailScreen.tsx`. Add it
   to the existing tab set:
   ```tsx
   const [tab, setTab] = useState<'open' | 'history' | 'performance'>('open');
   // ...
   <TabBtn active={tab === 'performance'} onClick={() => setTab('performance')}>
     Performance
   </TabBtn>
   // ...
   {tab === 'performance' && <CustomerPerformanceTab customerId={overview.id} />}
   ```

7. **Add the Vitest suite** at `tests/customerScorecard.test.ts`
   covering revenue/margin window aggregation, trend percentages,
   top-SKU ranking, refund subtraction, and bonus-line margin (per
   Section 20.11). The verifier covers SQL correctness; the vitest
   suite covers the projection layer. Target 12+ assertions.

## Out-of-bundle deliverables (still to write)

These were planned in Section 20 but not in this bundle. Add when
needed:

- **Settings → Loyalty tab integration into SettingsScreen.** The
  threshold-CRUD UI is the only remaining Wave H surface; the
  leaderboard view shipped as `CustomerLeaderboardView.tsx`.
- **`getEffectiveTier` consumers in driver client and voice agent**
  per Section 20.9 — implemented when Wave G driver client and Section
  19 voice agent ship. The function is exported and ready.

## Verification status

- Migration 0033: applied cleanly in WASM smoke test ✓
- Service code: TypeScript-only, not yet typechecked against the real
  codebase (project source not visible in current session). Drop into
  the real project and run `npm run typecheck` to confirm.
- Verifier `_verify_loyalty.mjs`: 33/33 PASS against the migration ✓

## Audit log actions added

Wave H emits these audit_log actions (mirrors Section 3 audit-log
expansion):

- `LOYALTY_THRESHOLD_CREATED` — new threshold row inserted
- `LOYALTY_THRESHOLD_UPDATED` — existing threshold edited
- `LOYALTY_THRESHOLD_DEACTIVATED` — threshold soft-deleted
- `LOYALTY_TIER_SET` — manual tier assigned to a customer
- `LOYALTY_TIER_CLEARED` — manual tier removed (falls back to computed)

Add these to the spec's audit-log catalogue in Section 3 when you next
revise CLAUDE.md.
