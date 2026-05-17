// DriverHomeScreen — touch-friendly driver-side UI. Wave G chunk 4c-lite.
//
// Becomes the default screen for DRIVER-role workers when they sign
// in. Shows the driver's currently-open route_runs (one per route per
// day) and, for each, the list of assigned orders with a big-tap
// "Log delivery" affordance per stop. The driver records outcomes as
// they finish each stop; the depot lead reconciles when the run
// closes.
//
// Layout is deliberately spacious — large buttons, fewer columns,
// minimal chrome — so it works on whatever tablet ends up being the
// driver's device. The LAN-sync layer (driver app on its own
// network-isolated device + Wi-Fi push to depot) is Section 18.6
// and remains deferred; for now the driver and depot share the same
// Counter DB.

import { useEffect, useState } from 'react';
import { useSession } from '../store/session';
import { counter } from '../lib/ipc';
import { formatMoney } from '../../shared/lib/money';
import LogDeliveryModal from '../components/LogDeliveryModal';
import type {
  RouteRunRowDto, PendingOrderRowDto, DeliveryAttemptRowDto,
} from '../../shared/types/ipc';

interface Props {
  onSignOut: () => void;
}

export default function DriverHomeScreen({ onSignOut }: Props): JSX.Element {
  const fullName = useSession((s) => s.fullName);
  const [runs, setRuns] = useState<RouteRunRowDto[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [orders, setOrders] = useState<PendingOrderRowDto[]>([]);
  const [attempts, setAttempts] = useState<DeliveryAttemptRowDto[]>([]);
  const [logFor, setLogFor] = useState<{ orderId: string; customerName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const r = await counter.routeRunMyOpen();
    if (r.success) {
      setRuns(r.data.runs);
      if (!selectedRunId && r.data.runs.length > 0) {
        setSelectedRunId(r.data.runs[0]!.id);
      }
    } else {
      setError(r.error);
    }
  }
  async function refreshSelected() {
    if (!selectedRunId) { setOrders([]); setAttempts([]); return; }
    const o = await counter.pendingOrderList({ routeRunId: selectedRunId, limit: 200 });
    if (o.success) setOrders(o.data.orders);
    const a = await counter.deliveryListForRun({ routeRunId: selectedRunId });
    if (a.success) setAttempts(a.data.attempts);
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { void refreshSelected(); }, [selectedRunId]);

  const selected = runs.find((r) => r.id === selectedRunId);
  const allLogged = orders.length > 0 && orders.every(
    (o) => attempts.some((a) => a.pendingOrderId === o.id),
  );

  async function logout() {
    await counter.logout();
    onSignOut();
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-baseline justify-between px-6 py-4 border-b border-border bg-bg-surface">
        <div className="flex items-baseline gap-3">
          <div className="text-2xl font-semibold tracking-tight">Driver</div>
          {fullName && <div className="text-text-tertiary">{fullName}</div>}
        </div>
        <button onClick={() => void logout()}
          className="text-xs text-text-tertiary hover:text-text-primary underline-offset-2 hover:underline">
          Sign out
        </button>
      </header>

      {error && (
        <div className="m-4 border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-4 max-w-3xl mx-auto w-full">
        {runs.length === 0 ? (
          <div className="text-center text-text-tertiary py-12 text-lg">
            No open runs assigned to you right now.
            <div className="mt-2 text-sm">Ask the depot lead to open a run and assign you as driver.</div>
          </div>
        ) : (
          <>
            {/* Run picker — usually only one open at a time, but tabs if more */}
            {runs.length > 1 && (
              <div className="flex gap-2 flex-wrap">
                {runs.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRunId(r.id)}
                    className={[
                      'px-4 py-3 border text-base',
                      selectedRunId === r.id ? 'bg-accent text-bg-deep border-accent' : 'border-border hover:bg-bg-elevated',
                    ].join(' ')}
                  >
                    {r.routeName} · {r.runDate}
                  </button>
                ))}
              </div>
            )}

            {selected && (
              <>
                <div className="border border-border rounded-lg p-4 bg-bg-elevated">
                  <div className="text-xl font-semibold">{selected.routeName}</div>
                  <div className="text-sm text-text-tertiary">
                    {selected.runDate} · opened {new Date(selected.openedAt).toLocaleTimeString()}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <Stat label="Assigned"  value={String(orders.length)} />
                    <Stat label="Logged"    value={String(attempts.length)} />
                    <Stat label="Remaining" value={String(Math.max(0, orders.length - attempts.length))} />
                  </div>
                </div>

                <div className="space-y-2">
                  {orders.length === 0 ? (
                    <div className="text-text-tertiary py-6 text-center">
                      No orders assigned to this run yet.
                    </div>
                  ) : orders.map((o) => {
                    const attempt = attempts.find((a) => a.pendingOrderId === o.id);
                    const tone = attempt
                      ? (attempt.outcome === 'DELIVERED' ? 'border-success'
                       : attempt.outcome === 'PARTIAL'   ? 'border-warning'
                       : 'border-danger')
                      : 'border-border';
                    return (
                      <button
                        key={o.id}
                        onClick={() => setLogFor({ orderId: o.id, customerName: o.customerName ?? '(no name)' })}
                        className={`block w-full text-left border-2 ${tone} px-4 py-3 hover:bg-bg-elevated`}
                      >
                        <div className="flex items-baseline justify-between">
                          <div className="text-lg font-semibold">{o.customerName}</div>
                          {attempt ? (
                            <span className={[
                              'text-xs px-2 py-0.5 border',
                              attempt.outcome === 'DELIVERED' ? 'border-success text-success'
                              : attempt.outcome === 'PARTIAL' ? 'border-warning text-warning'
                              : 'border-danger text-danger',
                            ].join(' ')}>{attempt.outcome}</span>
                          ) : (
                            <span className="text-xs text-text-tertiary">Tap to log</span>
                          )}
                        </div>
                        <div className="text-sm text-text-tertiary mt-1 font-mono tnum">
                          {o.lineCount} item{o.lineCount === 1 ? '' : 's'} ·
                          ₵{formatMoney(o.totalAtIntakePesewas)} at intake
                          {attempt && attempt.collectedCashPesewas > 0 && (
                            <> · collected ₵{formatMoney(attempt.collectedCashPesewas)}</>
                          )}
                          {attempt && attempt.collectedEmptiesCount > 0 && (
                            <> · {attempt.collectedEmptiesCount} empties</>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {allLogged && (
                  <div className="border-2 border-success bg-success/10 text-success px-4 py-3 text-center font-semibold">
                    All stops logged for this run. Hand the cash to the depot lead at debrief.
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {logFor && selectedRunId && (
        <LogDeliveryModal
          routeRunId={selectedRunId}
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
    <div className="border border-border bg-bg-deep px-3 py-2">
      <div className="text-text-tertiary text-xs uppercase tracking-wider">{label}</div>
      <div className="font-mono tnum text-2xl">{value}</div>
    </div>
  );
}
