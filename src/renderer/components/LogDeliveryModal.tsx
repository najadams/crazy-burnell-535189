// LogDeliveryModal — record (or update) a delivery_attempt for an
// assigned order. Used from RouteRunsScreen run detail.
//
// Pre-fills from any existing attempt for the order; on submit upserts
// via deliveryRecord. MISSED and REFUSED outcomes can't carry cash
// or empties — service rejects but the UI also disables those fields
// to make the rule visible.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import type {
  DeliveryOutcome, DeliveryAttemptRowDto,
} from '../../shared/types/ipc';

interface Props {
  routeRunId: string;
  pendingOrderId: string;
  customerName: string;
  onClose: () => void;
  onSaved: () => void;
}

const OUTCOME_LABEL: Record<DeliveryOutcome, string> = {
  DELIVERED: 'Delivered',
  PARTIAL:   'Partial',
  REFUSED:   'Refused',
  MISSED:    'Missed (not home)',
};

export default function LogDeliveryModal({
  routeRunId, pendingOrderId, customerName, onClose, onSaved,
}: Props): JSX.Element {
  const [outcome, setOutcome] = useState<DeliveryOutcome>('DELIVERED');
  const [cashCedis, setCashCedis] = useState('');
  const [emptiesCount, setEmptiesCount] = useState('0');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<DeliveryAttemptRowDto | null>(null);

  useEffect(() => {
    (async () => {
      const r = await counter.deliveryGetForOrder({ pendingOrderId });
      if (r.success && r.data.attempt) {
        const a = r.data.attempt;
        setExisting(a);
        setOutcome(a.outcome);
        setCashCedis((a.collectedCashPesewas / 100).toFixed(2));
        setEmptiesCount(String(a.collectedEmptiesCount));
        setNotes(a.notes ?? '');
      }
    })();
  }, [pendingOrderId]);

  // MISSED/REFUSED — cash and empties must be zero.
  const isNoCollection = outcome === 'MISSED' || outcome === 'REFUSED';

  async function submit() {
    setError(null);
    let cashPesewas = 0;
    if (!isNoCollection && cashCedis.trim()) {
      try { cashPesewas = parseCedisToPesewas(cashCedis); }
      catch { setError('Invalid cash amount.'); return; }
    }
    let empties = 0;
    if (!isNoCollection) {
      const parsed = parseInt(emptiesCount, 10);
      if (!Number.isFinite(parsed) || parsed < 0) { setError('Invalid empties count.'); return; }
      empties = parsed;
    }
    setBusy(true);
    const r = await counter.deliveryRecord({
      routeRunId, pendingOrderId, outcome,
      collectedCashPesewas: cashPesewas,
      collectedEmptiesCount: empties,
      notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">
            {existing ? 'Update delivery' : 'Log delivery'}: {customerName}
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>
        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">{error}</div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Outcome</label>
            <div className="grid grid-cols-2 gap-1">
              {(['DELIVERED','PARTIAL','REFUSED','MISSED'] as DeliveryOutcome[]).map((o) => (
                <button
                  key={o}
                  onClick={() => setOutcome(o)}
                  className={[
                    'px-3 py-2 text-sm border',
                    outcome === o ? 'bg-accent text-bg-deep border-accent' : 'border-border hover:bg-bg-elevated',
                  ].join(' ')}
                >{OUTCOME_LABEL[o]}</button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Cash collected (₵)</label>
            <input
              value={isNoCollection ? '0.00' : cashCedis}
              disabled={isNoCollection}
              onChange={(e) => setCashCedis(e.target.value)}
              inputMode="decimal" placeholder="0.00"
              className="w-full bg-bg-deep border border-border px-3 py-2 font-mono tnum text-center disabled:opacity-50"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Empties collected</label>
            <input
              value={isNoCollection ? '0' : emptiesCount}
              disabled={isNoCollection}
              onChange={(e) => setEmptiesCount(e.target.value)}
              inputMode="numeric" placeholder="0"
              className="w-full bg-bg-deep border border-border px-3 py-2 font-mono tnum text-center disabled:opacity-50"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Notes (optional)</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
              placeholder="e.g. customer asked to redeliver tomorrow" />
          </div>

          {existing && (
            <div className="text-xs text-text-tertiary">
              Updating existing record from {new Date(existing.attemptedAt).toLocaleString()}.
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} disabled={busy}
              className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated disabled:opacity-50">Cancel</button>
            <button onClick={() => void submit()} disabled={busy}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50">
              {busy ? 'Saving…' : (existing ? 'Update' : 'Log delivery')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
