# CustomersScreen integration — Top customers leaderboard

This is the patch sketch for adding the Wave H leaderboard view to the
existing `src/renderer/screens/CustomersScreen.tsx`. The screen currently
holds two states: an alphabetical list of customers and a drilled-in
`CustomerDetailScreen`. Wave H adds a third state: the ranked
leaderboard.

The cleanest pattern is a **view toggle** at the top of the customer list,
toggling between `'all'` and `'top'` modes. Drilling into a customer
works identically in both modes — same `CustomerDetailScreen` mount,
same back-out flow.

## Imports

Add at the top of `CustomersScreen.tsx`:

```tsx
import CustomerLeaderboardView from '../components/CustomerLeaderboardView';
```

## State

Add a view-mode state next to the existing detail-customer-id state:

```tsx
const [viewMode, setViewMode] = useState<'all' | 'top'>('all');
const [detailCustomerId, setDetailCustomerId] = useState<string | null>(null);
```

(The `detailCustomerId` state probably already exists with that name or a
similar one — keep whatever the screen already uses.)

## Render

Inside the screen body, above the existing customer list, add the toggle.
Then render the matching view:

```tsx
return (
  <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
    <AppHeader subtitle="customers" />
    <main className="flex-1 max-w-6xl w-full mx-auto px-12 py-6 flex flex-col gap-5">
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode('all')}
            className={[
              'px-3 py-1.5 text-sm border-b-2',
              viewMode === 'all'
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            All customers
          </button>
          <button
            onClick={() => setViewMode('top')}
            className={[
              'px-3 py-1.5 text-sm border-b-2',
              viewMode === 'top'
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            Top customers
          </button>
        </div>
        {/* existing right-side actions: Add Customer, search box, etc. */}
      </div>

      {viewMode === 'all' && (
        // existing alphabetical list — unchanged
        <ExistingAllCustomersList
          onSelect={(id) => setDetailCustomerId(id)}
        />
      )}

      {viewMode === 'top' && (
        <CustomerLeaderboardView
          onSelectCustomer={(id) => setDetailCustomerId(id)}
        />
      )}
    </main>

    {detailCustomerId && (
      <CustomerDetailScreen
        customerId={detailCustomerId}
        onExit={() => setDetailCustomerId(null)}
        onRecordPayment={/* existing */}
      />
    )}
  </div>
);
```

## Notes

- The leaderboard view is self-contained — it manages its own filter
  state (window, metric, channel, blocked-toggle, limit) and refetches
  on any filter change. The parent only needs to handle navigation.
- Both views drill into the same `CustomerDetailScreen` via
  `setDetailCustomerId`. When the user backs out of detail, they land
  back on whichever view they were in (`viewMode` is preserved).
- The toggle preserves the existing "All customers" list as the default,
  so users who don't care about the leaderboard never see it. It's
  opt-in via the toggle, which matches the visible-but-disabled role-gate
  philosophy from Section 11 — discoverable, not in the way.
- The leaderboard is OWNER-friendly but not OWNER-restricted. Any worker
  with login access can see who matters most this period. Threshold
  edits and manual-tier writes are still OWNER-only via the IPC handler
  layer.

## Optional polish (not required for v1)

- Persist `viewMode` to `localStorage` so the OWNER's preference is sticky:
  `useState(() => (localStorage.getItem('counter.customers.viewMode') as 'all'|'top') ?? 'all')`
  with a `useEffect` that writes on change.
- Add a "Performance" mini-icon next to each customer in the All view
  that drills directly into the Performance tab on the detail screen,
  bypassing the default Open/History tab.
- Wire a keyboard shortcut (e.g. `T` for "top") for power users.
