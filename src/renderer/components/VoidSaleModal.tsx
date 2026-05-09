// VoidSaleModal — confirm + void a previously rung-up sale.
// OWNER-gated; non-OWNER sees the trigger button disabled (Section 11).

import { useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoney } from '../../shared/lib/money';

interface Props {
  saleId: string;
  saleTotalPesewas: number;
  customerName: string | null;
  saleCreatedAt: string;
  onClose: () => void;
  onVoided: () => void;
}

export default function VoidSaleModal({
  saleId, saleTotalPesewas, customerName, saleCreatedAt, onClose, onVoided,
}: Props): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (reason.trim().length < 3) {
      setError('Please give a reason (at least a few characters) for the void.');
      return;
    }
    setBusy(true);
    const r = await counter.voidSale({ saleId, reason: reason.trim() });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    if (r.data.reversedBalancePesewas > 0) {
      window.alert(
        `Sale voided.\n` +
        `Customer balance reduced by ₵${formatMoney(r.data.reversedBalancePesewas)} ` +
        `(credit sale reversed).`,
      );
    } else {
      window.alert('Sale voided. Goods returned to stock.');
    }
    onVoided();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">Void sale</div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-bg-deep border border-border px-3 py-2 text-sm">
            <div className="text-xs text-text-tertiary mb-1">{new Date(saleCreatedAt).toLocaleString()}</div>
            <div className="flex justify-between">
              <span>{customerName ?? 'Walk-in'}</span>
              <span className="font-mono tnum">₵{formatMoney(saleTotalPesewas)}</span>
            </div>
          </div>

          <div className="text-sm text-text-secondary">
            Voiding will: mark this sale voided, return all sold units to stock,
            and (if it was a credit sale) reduce the customer's outstanding balance.
            This is recorded in the audit log and cannot be deleted — only reversed
            in the future via a separate void-reversal entry.
          </div>

          {!isOwner && (
            <div className="border border-warning bg-warning/10 text-warning px-3 py-2 text-sm rounded">
              OWNER role required to void a sale. Ask the owner to do this.
            </div>
          )}

          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
              {error}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Reason for void</label>
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={!isOwner}
              placeholder='e.g. "wrong product rang up", "customer changed mind"'
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm disabled:opacity-50"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated">
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy || !isOwner}
              className="px-4 py-2 bg-danger text-bg-deep font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? 'Voiding…' : 'Void sale'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
