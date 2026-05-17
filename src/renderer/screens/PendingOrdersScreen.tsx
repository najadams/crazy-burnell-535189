// PendingOrdersScreen — depot-side list and management of pending
// orders. Wave G chunk 2.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney } from '../../shared/lib/money';
import NewPendingOrderModal from '../components/NewPendingOrderModal';
import ConvertOrderModal from '../components/ConvertOrderModal';
import type {
  PendingOrderRowDto, PendingOrderStatus, RouteRunRowDto,
} from '../../shared/types/ipc';

interface Props { onBack: () => void }

type Filter = 'OPEN' | 'CONVERTED' | 'CANCELLED' | 'ALL';

const STATUS_LABEL: Record<PendingOrderStatus, string> = {
  CREATED: 'Created',
  ASSIGNED: 'Assigned',
  PICKED: 'Picked',
  OUT_FOR_DELIVERY: 'Out',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  CONVERTED: 'Converted',
  CANCELLED: 'Cancelled',
};

const STATUS_TONE: Record<PendingOrderStatus, string> = {
  CREATED: 'text-accent',
  ASSIGNED: 'text-accent',
  PICKED: 'text-accent',
  OUT_FOR_DELIVERY: 'text-warning',
  DELIVERED: 'text-success',
  FAILED: 'text-danger',
  CONVERTED: 'text-text-tertiary',
  CANCELLED: 'text-text-tertiary',
};

export default function PendingOrdersScreen({ onBack }: Props): JSX.Element {
  const [filter, setFilter] = useState<Filter>('OPEN');
  const [orders, setOrders] = useState<PendingOrderRowDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [convertId, setConvertId] = useState<string | null>(null);
  // Open runs available for assignment (refreshed alongside the order list).
  const [openRuns, setOpenRuns] = useState<RouteRunRowDto[]>([]);

  async function refresh() {
    const r = await counter.pendingOrderList({
      status: filter === 'ALL' ? undefined : filter,
      limit: 100,
    });
    if (r.success) setOrders(r.data.orders);
    else setError(r.error);
    const runs = await counter.routeRunList({ status: 'OPEN', limit: 20 });
    if (runs.success) setOpenRuns(runs.data.runs);
  }

  async function assignToRun(orderId: string, routeRunId: string) {
    const r = await counter.routeRunAssign({ pendingOrderId: orderId, routeRunId });
    if (!r.success) { setError(r.error); return; }
    await refresh();
  }
  async function unassignFromRun(orderId: string) {
    const r = await counter.routeRunUnassign({ pendingOrderId: orderId });
    if (!r.success) { setError(r.error); return; }
    await refresh();
  }

  useEffect(() => { void refresh(); }, [filter]);

  async function cancel(id: string) {
    const reason = window.prompt('Reason for cancelling this order?');
    if (!reason || reason.trim().length < 3) return;
    const r = await counter.pendingOrderCancel({ pendingOrderId: id, reason: reason.trim() });
    if (!r.success) { setError(r.error); return; }
    await refresh();
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-baseline justify-between px-6 py-4 border-b border-border bg-bg-surface">
        <div className="flex items-baseline gap-4">
          <button onClick={onBack} className="text-text-tertiary hover:text-text-primary text-sm">← Home</button>
          <div className="text-xl font-semibold tracking-tight">Pending orders</div>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="px-3 py-1.5 bg-accent text-bg-deep font-semibold text-sm"
        >
          + New order
        </button>
      </header>

      <div className="px-6 pt-3 border-b border-border bg-bg-surface flex gap-1">
        {(['OPEN','CONVERTED','CANCELLED','ALL'] as Filter[]).map((f) => (
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

      <div className="flex-1 overflow-auto p-4">
        {orders.length === 0 ? (
          <div className="text-text-tertiary text-sm p-4">
            No pending orders. Tap "New order" to capture a phone or in-person order.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-tertiary text-xs uppercase tracking-wider">
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Customer</th>
                <th className="text-left px-3 py-2">Channel</th>
                <th className="text-right px-3 py-2">Lines</th>
                <th className="text-right px-3 py-2">Total @ intake</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono tnum text-text-tertiary">
                    {new Date(o.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    {o.customerName}
                    {o.requiresReview && (
                      <span className="ml-2 text-xs text-warning border border-warning px-1">REVIEW</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-tertiary">
                    {o.intakeChannel.replace('_', ' ').toLowerCase()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tnum">{o.lineCount}</td>
                  <td className="px-3 py-2 text-right font-mono tnum">₵{formatMoney(o.totalAtIntakePesewas)}</td>
                  <td className={`px-3 py-2 text-xs ${STATUS_TONE[o.status]}`}>{STATUS_LABEL[o.status]}</td>
                  <td className="px-3 py-2 text-right space-x-1 whitespace-nowrap">
                    {o.status === 'CREATED' && (
                      <>
                        {openRuns.length > 0 && (
                          <select
                            onChange={(e) => {
                              const id = e.target.value;
                              if (id) void assignToRun(o.id, id);
                              e.currentTarget.value = '';
                            }}
                            defaultValue=""
                            className="text-xs border border-border bg-bg-deep px-1 py-1"
                          >
                            <option value="">Assign…</option>
                            {openRuns.map((rr) => (
                              <option key={rr.id} value={rr.id}>
                                {rr.routeName} · {rr.runDate} · {rr.driverName}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          onClick={() => setConvertId(o.id)}
                          className="px-2 py-1 text-xs border border-accent text-accent hover:bg-accent hover:text-bg-deep"
                        >Convert</button>
                        <button
                          onClick={() => void cancel(o.id)}
                          className="px-2 py-1 text-xs border border-danger text-danger hover:bg-danger hover:text-bg-deep"
                        >Cancel</button>
                      </>
                    )}
                    {o.status === 'ASSIGNED' && (
                      <>
                        <button
                          onClick={() => void unassignFromRun(o.id)}
                          className="px-2 py-1 text-xs border border-warning text-warning hover:bg-warning hover:text-bg-deep"
                        >Unassign</button>
                        <button
                          onClick={() => setConvertId(o.id)}
                          className="px-2 py-1 text-xs border border-accent text-accent hover:bg-accent hover:text-bg-deep"
                        >Convert</button>
                        <button
                          onClick={() => void cancel(o.id)}
                          className="px-2 py-1 text-xs border border-danger text-danger hover:bg-danger hover:text-bg-deep"
                        >Cancel</button>
                      </>
                    )}
                    {o.status === 'CONVERTED' && o.conversionSaleId && (
                      <span className="text-xs text-text-tertiary font-mono tnum">
                        {o.conversionSaleId.slice(0, 12)}…
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NewPendingOrderModal
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); void refresh(); }}
        />
      )}

      {convertId && (
        <ConvertOrderModal
          pendingOrderId={convertId}
          onClose={() => setConvertId(null)}
          onConverted={() => {
            setConvertId(null);
            void refresh();
            window.alert('Order converted to sale.');
          }}
        />
      )}
    </div>
  );
}
