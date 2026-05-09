// RecordPaymentModal — record a customer payment with FIFO allocation
// against open credit sales.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import type { CustomerPaymentMethod } from '../../shared/types/ipc';

interface Props {
  customerId: string;
  customerName: string;
  currentBalancePesewas: number;
  onClose: () => void;
  onRecorded: () => void;
}

const METHOD_OPTIONS: Array<{ value: CustomerPaymentMethod; label: string }> = [
  { value: 'CASH', label: 'Cash (in-shop)' },
  { value: 'MOMO', label: 'Mobile money' },
  { value: 'BANK', label: 'Bank transfer' },
];

export default function RecordPaymentModal({
  customerId, customerName, currentBalancePesewas, onClose, onRecorded,
}: Props): JSX.Element {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<CustomerPaymentMethod>('CASH');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [openSales, setOpenSales] = useState<Array<{
    saleId: string; createdAt: string; openBalancePesewas: number;
  }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    allocations: Array<{ saleId: string; amountPesewas: number }>;
    unallocatedPesewas: number;
    newBalancePesewas: number;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const r = await counter.openCreditSales({ customerId });
      if (r.success) setOpenSales(r.data.sales);
    })();
  }, [customerId]);

  // Suggest paying the full balance.
  useEffect(() => {
    if (!amount && currentBalancePesewas > 0) {
      setAmount((currentBalancePesewas / 100).toFixed(2));
    }
  }, [currentBalancePesewas, amount]);

  async function submit() {
    setError(null);
    let pesewas: number;
    try { pesewas = parseCedisToPesewas(amount); }
    catch (e: any) { setError(e?.message ?? 'Invalid amount.'); return; }
    if (pesewas <= 0) { setError('Amount must be greater than zero.'); return; }
    if (method === 'MOMO' && !reference.trim()) {
      setError('Mobile-money payments need a reference (the txn id).');
      return;
    }

    setBusy(true);
    const r = await counter.recordCustomerPayment({
      customerId,
      amountPesewas: pesewas,
      paymentMethod: method,
      paymentReference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    setResult(r.data);
  }

  if (result) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
        <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
          <div className="px-6 py-4 border-b border-border">
            <div className="text-lg font-semibold text-success">Payment recorded</div>
          </div>
          <div className="p-6 space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-text-secondary">Allocated to</span>
              <span>{result.allocations.length} open sale{result.allocations.length === 1 ? '' : 's'}</span>
            </div>
            {result.allocations.map((a) => (
              <div key={a.saleId} className="flex justify-between text-xs text-text-tertiary">
                <span className="font-mono tnum">{a.saleId.slice(0, 16)}…</span>
                <span className="font-mono tnum">₵{formatMoney(a.amountPesewas)}</span>
              </div>
            ))}
            {result.unallocatedPesewas > 0 && (
              <div className="border border-warning bg-warning/10 px-3 py-2 rounded">
                <div className="text-warning font-semibold">
                  ₵{formatMoney(result.unallocatedPesewas)} unallocated
                </div>
                <div className="text-xs text-text-tertiary mt-1">
                  This is store credit — it sits on the customer's balance and will
                  apply against the next credit sale. The new balance is{' '}
                  <span className="font-mono tnum text-text-primary">
                    ₵{formatMoney(result.newBalancePesewas)}
                  </span>{result.newBalancePesewas < 0 ? ' (shop owes the customer).' : '.'}
                </div>
              </div>
            )}
            {result.unallocatedPesewas === 0 && (
              <div className="flex justify-between border-t border-border pt-3">
                <span className="text-text-secondary">New balance</span>
                <span className="font-mono tnum">₵{formatMoney(result.newBalancePesewas)}</span>
              </div>
            )}
            <div className="flex justify-end pt-2">
              <button onClick={onRecorded}
                      className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm">
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">Record payment</div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-bg-deep border border-border px-3 py-2 text-sm">
            <div className="font-semibold">{customerName}</div>
            <div className="text-text-tertiary text-xs">
              Open balance:{' '}
              <span className="font-mono tnum text-text-primary">
                ₵{formatMoney(currentBalancePesewas)}
              </span>
              {openSales.length > 0 && (
                <span> across {openSales.length} unpaid sale{openSales.length === 1 ? '' : 's'}</span>
              )}
            </div>
          </div>

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
            <div className="text-xs text-text-tertiary">
              Will allocate FIFO across open sales (oldest first). Excess becomes
              store credit.
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Method</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as CustomerPaymentMethod)}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
            >
              {METHOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          {(method === 'MOMO' || method === 'BANK') && (
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">
                Reference {method === 'MOMO' ? '(MoMo transaction id)' : '(bank txn id)'}
              </label>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="w-full bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum"
              />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Notes (optional)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose}
                    className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated">
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy || !amount}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50"
            >
              {busy ? 'Recording…' : 'Record payment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
