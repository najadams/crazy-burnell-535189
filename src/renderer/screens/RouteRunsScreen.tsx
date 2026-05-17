// RouteRunsScreen — depot-side route run management. Wave G chunk 3d.
//
// Left pane: list of runs (filterable by status). Right pane: detail
// for the selected run with assigned orders and the available
// actions (Close, Reconcile, Reopen). "Open new run" lives in a
// modal so the screen isn't dominated by a form when most of the
// time the user is just monitoring.

import { useEffect, useState } from 'react';
import { useSession } from '../store/session';
import { counter } from '../lib/ipc';
import { formatMoney } from '../../shared/lib/money';
import type {
  RouteRunRowDto, RouteRunStatus, PendingOrderRowDto,
  RouteRowDto, WorkerSummary,
  DeliveryAttemptRowDto,
} from '../../shared/types/ipc';
import LogDeliveryModal from '../components/LogDeliveryModal';

interface Props { onBack: () => void }

type Filter = 'OPEN' | 'CLOSED' | 'RECONCILED' | 'ALL';

const STATUS_TONE: Record<RouteRunStatus, string> = {
  OPEN:       'text-accent',
  RETURNING:  'text-accent',
  CLOSED:     'text-warning',
  RECONCILED: 'text-text-tertiary',
};

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function RouteRunsScreen({ onBack }: Props): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwnerLike = role === 'OWNER' || role === 'FOUNDER';

  const [filter, setFilter] = useState<Filter>('OPEN');
  const [runs, setRuns] = useState<RouteRunRowDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<PendingOrderRowDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showOpen, setShowOpen] = useState(false);
  const [closeFor, setCloseFor] = useState<RouteRunRowDto | null>(null);
  const [logFor, setLogFor] = useState<{ orderId: string; customerName: string } | null>(null);
  const [attempts, setAttempts] = useState<DeliveryAttemptRowDto[]>([]);

  async function refreshRuns() {
    const status = filter === 'ALL' ? undefined : (filter === 'OPEN' ? 'OPEN' : filter);
    const r = await counter.routeRunList({ status, limit: 50 });
    if (r.success) setRuns(r.data.runs);
    else setError(r.error);
  }
  async function refreshSelected() {
    if (!selectedId) { setSelectedOrders([]); setAttempts([]); return; }
    const r = await counter.pendingOrderList({ routeRunId: selectedId, limit: 200 });
    if (r.success) setSelectedOrders(r.data.orders);
    const a = await counter.deliveryListForRun({ routeRunId: selectedId });
    if (a.success) setAttempts(a.data.attempts);
  }

  useEffect(() => { void refreshRuns(); }, [filter]);
  useEffect(() => { if (selectedId) void refreshSelected(); }, [selectedId]);

  const selected = runs.find((r) => r.id === selectedId);

  async function reconcile(runId: string) {
    const notes = window.prompt('Reconciliation notes (optional):') ?? '';
    const r = await counter.routeRunReconcile({ routeRunId: runId, notes: notes.trim() || undefined });
    if (!r.success) { setError(r.error); return; }
    await refreshRuns();
  }
  async function reopen(runId: string) {
    const reason = window.prompt('Reason for reopening this run?');
    if (!reason || reason.trim().length < 3) return;
    const r = await counter.routeRunReopen({ routeRunId: runId, reason: reason.trim() });
    if (!r.success) { setError(r.error); return; }
    await refreshRuns();
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-baseline justify-between px-6 py-4 border-b border-border bg-bg-surface">
        <div className="flex items-baseline gap-4">
          <button onClick={onBack} className="text-text-tertiary hover:text-text-primary text-sm">← Home</button>
          <div className="text-xl font-semibold tracking-tight">Route runs</div>
        </div>
        {isOwnerLike && (
          <button
            onClick={() => setShowOpen(true)}
            className="px-3 py-1.5 bg-accent text-bg-deep font-semibold text-sm"
          >+ Open run</button>
        )}
      </header>

      <div className="px-6 pt-3 border-b border-border bg-bg-surface flex gap-1">
        {(['OPEN','CLOSED','RECONCILED','ALL'] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={[
              'px-4 py-2 text-sm border-b-2 -mb-px',
              filter === f ? 'border-accent text-accent' : 'border-transparent text-text-tertiary hover:text-text-primary',
            ].join(' ')}
          >{f}</button>
        ))}
      </div>

      {error && (
        <div className="m-4 border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}

      <div className="flex-1 grid grid-cols-2 gap-4 p-4 overflow-hidden">
        <div className="overflow-auto space-y-1 border-r border-border pr-4">
          {runs.length === 0 ? (
            <div className="text-text-tertiary text-sm">No runs in this view.</div>
          ) : runs.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className={[
                'block w-full text-left px-3 py-2 border text-sm',
                selectedId === r.id ? 'border-accent bg-bg-elevated' : 'border-border hover:bg-bg-elevated',
              ].join(' ')}
            >
              <div className="flex items-baseline justify-between">
                <span>{r.routeName}</span>
                <span className={`text-xs ${STATUS_TONE[r.status]}`}>{r.status}</span>
              </div>
              <div className="text-xs text-text-tertiary font-mono tnum">
                {r.runDate} · {r.driverName} ·
                {r.assignedOrderCount} order{r.assignedOrderCount === 1 ? '' : 's'}
                {r.closingCashPesewas != null && (
                  <> · cash ₵{formatMoney(r.closingCashPesewas)}</>
                )}
              </div>
            </button>
          ))}
        </div>

        <div className="overflow-auto space-y-3">
          {!selected ? (
            <div className="text-sm text-text-tertiary">Select a run to see detail.</div>
          ) : (
            <>
              <div>
                <div className="text-lg font-semibold">{selected.routeName}</div>
                <div className="text-xs text-text-tertiary">
                  {selected.runDate} · driver {selected.driverName} · opened {new Date(selected.openedAt).toLocaleString()}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs">
                <Stat label="Assigned"  value={String(selected.assignedOrderCount)} />
                <Stat label="Converted" value={String(selected.convertedOrderCount)} />
                <Stat label="Cancelled" value={String(selected.cancelledOrderCount)} />
              </div>

              {selected.closingCashPesewas != null && (
                <div className="bg-bg-elevated border border-border px-3 py-2 text-sm">
                  Closing cash: ₵{formatMoney(selected.closingCashPesewas)} · closed {selected.closedAt && new Date(selected.closedAt).toLocaleString()}
                </div>
              )}
              {selected.reopenedAt && (
                <div className="bg-bg-elevated border border-warning text-warning px-3 py-2 text-xs">
                  Reopened {new Date(selected.reopenedAt).toLocaleString()} — {selected.reopenReason}
                </div>
              )}

              <div>
                <div className="text-sm font-semibold mb-1">Assigned orders</div>
                {selectedOrders.length === 0 ? (
                  <div className="text-xs text-text-tertiary">No orders assigned to this run.</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-text-tertiary text-xs uppercase tracking-wider">
                        <th className="text-left py-1">Customer</th>
                        <th className="text-right py-1">Lines</th>
                        <th className="text-right py-1">Total @ intake</th>
                        <th className="text-left py-1">Status</th>
                        <th className="text-right py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedOrders.map((o) => (
                        <tr key={o.id} className="border-t border-border">
                          <td className="py-1">{o.customerName}</td>
                          <td className="py-1 text-right font-mono tnum">{o.lineCount}</td>
                          <td className="py-1 text-right font-mono tnum">₵{formatMoney(o.totalAtIntakePesewas)}</td>
                          <td className="py-1 text-xs">{o.status}</td>
                          <td className="py-1 text-right space-x-1">
                            {selected.status !== 'RECONCILED' && (() => {
                              const attempt = attempts.find((a) => a.pendingOrderId === o.id);
                              return (
                                <button
                                  onClick={() => setLogFor({ orderId: o.id, customerName: o.customerName ?? '(no name)' })}
                                  className={[
                                    'text-xs px-1.5 py-0.5 border',
                                    attempt
                                      ? 'border-text-tertiary text-text-tertiary hover:bg-bg-deep'
                                      : 'border-accent text-accent hover:bg-accent hover:text-bg-deep',
                                  ].join(' ')}
                                >{attempt ? `${attempt.outcome}` : 'Log delivery'}</button>
                              );
                            })()}
                            {o.status === 'ASSIGNED' && selected.status === 'OPEN' && (
                              <button
                                onClick={async () => {
                                  const r = await counter.routeRunUnassign({ pendingOrderId: o.id });
                                  if (!r.success) setError(r.error);
                                  else { await refreshRuns(); await refreshSelected(); }
                                }}
                                className="text-xs px-1.5 py-0.5 border border-warning text-warning hover:bg-warning hover:text-bg-deep"
                              >Unassign</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="text-xs text-text-tertiary">
                After the driver returns, close the run with the cash
                they handed over; then convert each order to a sale
                via Orders (the assign field passes through); then
                reconcile when every assigned order has reached
                CONVERTED or CANCELLED.
              </div>

              <div className="flex gap-2">
                {selected.status === 'OPEN' && (
                  <button
                    onClick={() => setCloseFor(selected)}
                    className="text-sm px-3 py-2 border border-warning text-warning hover:bg-warning hover:text-bg-deep"
                  >Close run</button>
                )}
                {selected.status === 'CLOSED' && isOwnerLike && (
                  <>
                    <button
                      onClick={() => void reconcile(selected.id)}
                      className="text-sm px-3 py-2 border border-accent text-accent hover:bg-accent hover:text-bg-deep"
                    >Reconcile</button>
                    {!selected.reopenedAt && (
                      <button
                        onClick={() => void reopen(selected.id)}
                        className="text-sm px-3 py-2 border border-danger text-danger hover:bg-danger hover:text-bg-deep"
                      >Reopen</button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {showOpen && (
        <OpenRunModal
          onClose={() => setShowOpen(false)}
          onOpened={() => { setShowOpen(false); void refreshRuns(); }}
        />
      )}
      {closeFor && (
        <CloseRunModal
          run={closeFor}
          onClose={() => setCloseFor(null)}
          onClosed={() => { setCloseFor(null); void refreshRuns(); }}
        />
      )}

      {logFor && selected && (
        <LogDeliveryModal
          routeRunId={selected.id}
          pendingOrderId={logFor.orderId}
          customerName={logFor.customerName}
          onClose={() => setLogFor(null)}
          onSaved={async () => { setLogFor(null); await refreshSelected(); }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="bg-bg-elevated border border-border px-3 py-2">
      <div className="text-text-tertiary uppercase tracking-wider">{label}</div>
      <div className="font-mono tnum text-lg">{value}</div>
    </div>
  );
}

function OpenRunModal({ onClose, onOpened }: {
  onClose: () => void; onOpened: () => void;
}): JSX.Element {
  const [routes, setRoutes] = useState<RouteRowDto[]>([]);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [routeId, setRouteId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [runDate, setRunDate] = useState(todayDate());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await counter.routeList({ includeArchived: false });
      if (r.success) setRoutes(r.data.routes);
      const w = await counter.listWorkers();
      if (w.success) setWorkers(w.data.workers);
    })();
  }, []);

  async function submit() {
    setError(null);
    if (!routeId) { setError('Pick a route.'); return; }
    if (!driverId) { setError('Pick a driver.'); return; }
    setBusy(true);
    const r = await counter.routeRunOpen({ routeId, driverId, runDate, notes: notes.trim() || undefined });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    onOpened();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">Open route run</div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>
        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">{error}</div>
          )}
          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Route</label>
            <select value={routeId} onChange={(e) => setRouteId(e.target.value)}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm">
              <option value="">— pick route —</option>
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.weekdayPattern || 'no schedule'}) · {r.stopCount} stops
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Driver</label>
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm">
              <option value="">— pick driver —</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>{w.fullName} ({w.role})</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Run date</label>
            <input type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Notes (optional)</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} disabled={busy}
              className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated disabled:opacity-50">Cancel</button>
            <button onClick={() => void submit()} disabled={busy || !routeId || !driverId}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50">
              {busy ? 'Opening…' : 'Open run'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CloseRunModal({ run, onClose, onClosed }: {
  run: RouteRunRowDto; onClose: () => void; onClosed: () => void;
}): JSX.Element {
  const [cashCedis, setCashCedis] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    const cashPesewas = Math.round(parseFloat(cashCedis) * 100);
    if (!Number.isFinite(cashPesewas) || cashPesewas < 0) {
      setError('Closing cash must be ≥ 0.'); return;
    }
    setBusy(true);
    const r = await counter.routeRunClose({
      routeRunId: run.id, closingCashPesewas: cashPesewas,
      notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    onClosed();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">Close run: {run.routeName}</div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>
        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">{error}</div>
          )}
          <div className="text-xs text-text-tertiary">
            Type the total cash the driver handed over for this run.
            This is the blind count — what you measured before any
            conversion. After close, you'll convert each assigned
            order via the Orders screen with that customer's
            actual payment breakdown.
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Cash handed over (₵)</label>
            <input
              value={cashCedis} onChange={(e) => setCashCedis(e.target.value)}
              autoFocus inputMode="decimal" placeholder="0.00"
              className="w-full bg-bg-deep border border-border px-3 py-2 font-mono tnum text-center text-lg"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Notes (optional)</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} disabled={busy}
              className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated disabled:opacity-50">Cancel</button>
            <button onClick={() => void submit()} disabled={busy}
              className="px-4 py-2 bg-warning text-bg-deep font-semibold text-sm disabled:opacity-50">
              {busy ? 'Closing…' : 'Close run'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
