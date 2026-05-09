// CashDropModal — record cash leaving the till mid-shift.
//
// Reasons map to the spec's CASH_DROP categories. We record a free-form
// note in addition (e.g. "OWNER_TAKE: bought bread for the runners").

import { useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import type { CashDropReason } from '../../shared/types/ipc';

interface Props {
  onClose: () => void;
  onRecorded: () => void;
}

const REASON_OPTIONS: Array<{ value: CashDropReason; label: string }> = [
  { value: 'OWNER_TAKE',       label: 'Owner take (cash to owner)' },
  { value: 'SUPPLIER_PAYMENT', label: 'Supplier payment' },
  { value: 'RUNNER_ADVANCE',   label: 'Runner / driver advance' },
  { value: 'CUSTOMER_REFUND',  label: 'Customer refund' },
  { value: 'EXPENSE',          label: 'Expense / petty cash' },
  { value: 'OTHER',            label: 'Other (explain in note)' },
];

export default function CashDropModal({ onClose, onRecorded }: Props): JSX.Element {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<CashDropReason>('OWNER_TAKE');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    let pesewas: number;
    try { pesewas = parseCedisToPesewas(amount); }
    catch (e: any) { setError(e?.message ?? 'Invalid amount.'); return; }
    if (pesewas <= 0) { setError('Amount must be greater than zero.'); return; }
    if (reason === 'OTHER' && !note.trim()) {
      setError('Please add a note explaining the drop.'); return;
    }
    setBusy(true);
    const r = await counter.recordCashDrop({
      amountPesewas: pesewas, reason, note: note.trim(),
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    window.alert(
      `Cash drop recorded.\n` +
      `₵${formatMoney(pesewas)} reason "${reason}" — closing count is now reduced by this amount.`,
    );
    onRecorded();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">Cash drop</div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>
        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
              {error}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Amount (cedis)</label>
            <input
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Reason</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as CashDropReason)}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
            >
              {REASON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text-secondary">
              Note {reason === 'OTHER' ? '(required)' : '(optional)'}
            </label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder='e.g. "bought bread for runners"'
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated">
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy || !amount}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50"
            >
              {busy ? 'Recording…' : 'Record drop'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
