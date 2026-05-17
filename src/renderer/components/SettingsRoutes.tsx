// SettingsRoutes — manage the depot's route rotations (Wave G chunk 3).
//
// Two-pane layout: list of routes on the left, selected route's stop
// detail on the right. OWNER-only writes (create route, add stop,
// remove stop, reorder, archive); list/list-stops are open to any
// signed-in worker so a driver could glance at the rotation without
// modify rights.

import { useEffect, useState } from 'react';
import { useSession } from '../store/session';
import { counter } from '../lib/ipc';
import { formatGhanaPhone } from '../../shared/lib/phone';
import type {
  RouteRowDto, RouteStopRowDto, CustomerSummary,
} from '../../shared/types/ipc';

const WEEKDAY_CODES = ['MON','TUE','WED','THU','FRI','SAT','SUN'] as const;

export default function SettingsRoutes(): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwnerLike = role === 'OWNER' || role === 'FOUNDER';

  const [routes, setRoutes] = useState<RouteRowDto[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stops, setStops] = useState<RouteStopRowDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // New-route form state
  const [newName, setNewName] = useState('');
  const [newPattern, setNewPattern] = useState<Set<string>>(new Set());
  const [newNotes, setNewNotes] = useState('');

  // Add-stop state
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [customerPick, setCustomerPick] = useState('');

  async function refreshRoutes() {
    const r = await counter.routeList({ includeArchived: showArchived });
    if (r.success) setRoutes(r.data.routes);
    else setError(r.error);
  }
  async function refreshStops(routeId: string) {
    const r = await counter.routeListStops({ routeId });
    if (r.success) setStops(r.data.stops);
    else setError(r.error);
  }
  useEffect(() => { void refreshRoutes(); }, [showArchived]);
  useEffect(() => {
    if (selectedId) void refreshStops(selectedId);
    else setStops([]);
  }, [selectedId]);
  useEffect(() => {
    (async () => {
      const c = await counter.listCustomers({});
      if (c.success) setCustomers(c.data.customers);
    })();
  }, []);

  // Default selection: first active route on load
  useEffect(() => {
    if (!selectedId && routes.length > 0) setSelectedId(routes[0].id);
  }, [routes]);

  const selected = routes.find((r) => r.id === selectedId);

  async function submitCreate() {
    setError(null);
    if (newName.trim().length < 2) { setError('Route name must be at least 2 characters.'); return; }
    setCreating(true);
    const pattern = Array.from(WEEKDAY_CODES).filter((d) => newPattern.has(d)).join(',');
    const r = await counter.routeCreate({
      name: newName.trim(),
      weekdayPattern: pattern,
      notes: newNotes.trim() || undefined,
    });
    setCreating(false);
    if (!r.success) { setError(r.error); return; }
    setNewName(''); setNewPattern(new Set()); setNewNotes('');
    await refreshRoutes();
    setSelectedId(r.data.routeId);
  }

  async function archive(routeId: string) {
    if (!window.confirm('Archive this route? It stops showing in the active list but stop history is preserved.')) return;
    const r = await counter.routeArchive({ routeId });
    if (!r.success) { setError(r.error); return; }
    await refreshRoutes();
  }
  async function reactivate(routeId: string) {
    const r = await counter.routeReactivate({ routeId });
    if (!r.success) { setError(r.error); return; }
    await refreshRoutes();
  }

  async function addStopByPick() {
    if (!selectedId || !customerPick) return;
    setError(null);
    const r = await counter.routeAddStop({ routeId: selectedId, customerId: customerPick });
    if (!r.success) { setError(r.error); return; }
    setCustomerPick('');
    await refreshStops(selectedId);
    await refreshRoutes(); // stopCount changed
  }
  async function removeStop(stopId: string) {
    if (!selectedId) return;
    const r = await counter.routeRemoveStop({ stopId });
    if (!r.success) { setError(r.error); return; }
    await refreshStops(selectedId);
    await refreshRoutes();
  }
  async function moveStop(stopId: string, direction: -1 | 1) {
    if (!selectedId) return;
    const ids = stops.map((s) => s.id);
    const idx = ids.indexOf(stopId);
    if (idx < 0) return;
    const swap = idx + direction;
    if (swap < 0 || swap >= ids.length) return;
    const next = ids.slice();
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    const r = await counter.routeReorderStops({ routeId: selectedId, orderedStopIds: next });
    if (!r.success) { setError(r.error); return; }
    await refreshStops(selectedId);
  }

  function toggleWeekday(code: string) {
    setNewPattern((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  // Customers not yet on the selected route — used for the add-stop picker
  const eligibleCustomers = customers.filter((c) => {
    if (c.blocked) return false;
    if (!selectedId) return false;
    return !stops.some((s) => s.customerId === c.id);
  });

  return (
    <div className="space-y-6">
      <div>
        <div className="text-lg font-semibold">Routes</div>
        <div className="text-sm text-text-tertiary mt-1">
          Stable customer rotations the driver runs on specific weekdays.
          Each route has an ordered list of stops; orders for those
          customers will eventually be assigned to a route run (next
          chunk).
        </div>
      </div>

      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {/* Left: routes list + create form */}
        <div className="space-y-4 border-r border-border pr-4">
          <div className="flex items-baseline justify-between">
            <div className="text-sm font-semibold">All routes</div>
            <label className="text-xs text-text-tertiary flex items-center gap-1">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived
            </label>
          </div>

          {routes.length === 0 ? (
            <div className="text-sm text-text-tertiary">No routes yet.</div>
          ) : (
            <div className="space-y-1">
              {routes.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={[
                    'block w-full text-left px-3 py-2 border text-sm',
                    selectedId === r.id ? 'border-accent bg-bg-elevated' : 'border-border hover:bg-bg-elevated',
                  ].join(' ')}
                >
                  <div className="flex items-baseline justify-between">
                    <span>{r.name}</span>
                    {!r.active && <span className="text-xs text-text-tertiary">archived</span>}
                  </div>
                  <div className="text-xs text-text-tertiary font-mono tnum">
                    {r.weekdayPattern || '— no schedule —'} · {r.stopCount} stop{r.stopCount === 1 ? '' : 's'}
                  </div>
                </button>
              ))}
            </div>
          )}

          {isOwnerLike && (
            <div className="border-t border-border pt-4 space-y-2">
              <div className="text-sm font-semibold">New route</div>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Tuesday Eastern"
                className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap gap-1">
                {WEEKDAY_CODES.map((d) => (
                  <button
                    key={d}
                    onClick={() => toggleWeekday(d)}
                    className={[
                      'px-2 py-1 text-xs border',
                      newPattern.has(d) ? 'bg-accent text-bg-deep border-accent' : 'border-border hover:bg-bg-elevated',
                    ].join(' ')}
                  >{d}</button>
                ))}
              </div>
              <input
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                placeholder="Notes (optional)"
                className="w-full bg-bg-deep border border-border px-3 py-2 text-xs"
              />
              <button
                onClick={() => void submitCreate()}
                disabled={creating || newName.trim().length < 2}
                className="text-sm px-3 py-2 border border-accent text-accent hover:bg-accent hover:text-bg-deep disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create route'}
              </button>
            </div>
          )}
        </div>

        {/* Right: stop detail for selected route */}
        <div className="space-y-3">
          {!selected ? (
            <div className="text-sm text-text-tertiary">Select a route to manage its stops.</div>
          ) : (
            <>
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-sm font-semibold">{selected.name}</div>
                  <div className="text-xs text-text-tertiary">{selected.weekdayPattern || 'no schedule'}</div>
                </div>
                {isOwnerLike && (
                  selected.active ? (
                    <button onClick={() => void archive(selected.id)}
                      className="text-xs px-2 py-1 border border-warning text-warning hover:bg-warning hover:text-bg-deep">
                      Archive
                    </button>
                  ) : (
                    <button onClick={() => void reactivate(selected.id)}
                      className="text-xs px-2 py-1 border border-accent text-accent hover:bg-accent hover:text-bg-deep">
                      Reactivate
                    </button>
                  )
                )}
              </div>

              <div className="space-y-1">
                {stops.length === 0 ? (
                  <div className="text-sm text-text-tertiary">No stops yet.</div>
                ) : (
                  stops.map((s, i) => (
                    <div key={s.id} className="flex items-center gap-2 bg-bg-elevated border border-border px-2 py-1">
                      <span className="font-mono tnum text-xs text-text-tertiary w-6 text-right">{s.stopOrder}.</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{s.customerName}</div>
                        <div className="text-xs text-text-tertiary">{formatGhanaPhone(s.customerPhone)}</div>
                      </div>
                      {isOwnerLike && selected.active && (
                        <>
                          <button
                            disabled={i === 0}
                            onClick={() => void moveStop(s.id, -1)}
                            className="text-xs px-1.5 py-0.5 border border-border disabled:opacity-30 hover:bg-bg-deep"
                            title="Move up"
                          >↑</button>
                          <button
                            disabled={i === stops.length - 1}
                            onClick={() => void moveStop(s.id, 1)}
                            className="text-xs px-1.5 py-0.5 border border-border disabled:opacity-30 hover:bg-bg-deep"
                            title="Move down"
                          >↓</button>
                          <button
                            onClick={() => void removeStop(s.id)}
                            className="text-xs px-1.5 py-0.5 border border-danger text-danger hover:bg-danger hover:text-bg-deep"
                            title="Remove"
                          >×</button>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>

              {isOwnerLike && selected.active && (
                <div className="border-t border-border pt-3 space-y-2">
                  <div className="text-xs text-text-secondary uppercase tracking-wider">Add stop</div>
                  <div className="flex gap-2">
                    <select
                      value={customerPick}
                      onChange={(e) => setCustomerPick(e.target.value)}
                      className="flex-1 bg-bg-deep border border-border px-2 py-1 text-sm"
                    >
                      <option value="">— pick customer —</option>
                      {eligibleCustomers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName} ({c.customerType})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => void addStopByPick()}
                      disabled={!customerPick}
                      className="text-sm px-3 py-1 border border-accent text-accent hover:bg-accent hover:text-bg-deep disabled:opacity-50"
                    >Add</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
