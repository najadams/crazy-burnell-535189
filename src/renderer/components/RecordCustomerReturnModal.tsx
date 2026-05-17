// RecordCustomerReturnModal — record a customer return with line
// items + refund method. Wave C.3.
//
// Flow: cashier picks products + quantities + refund unit prices,
// chooses CASH or CREDIT refund, types notes, hits Record. The
// supervisor PIN modal opens (purpose CUSTOMER_RETURN) and the
// returned approval id is threaded into the service call. STORE
// refund is hidden because the service rejects it.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import SupervisorPinModal from './SupervisorPinModal';
import type {
  CustomerReturnRefundMethod, CustomerReturnLineInputDto,
  ProductSummary,
} from '../../shared/types/ipc';

interface Props {
  customerId: string;
  customerName: string;
  onClose: () => void;
  onRecorded: (returnId: string, totalPesewas: number) => void;
}

interface DraftLine {
  productId: string;
  productName: string;
  quantity: number;
  refundUnitCedis: string;
  notes: string;
}

function defaultRefundCedis(p: ProductSummary): string {
  return (p.wholesalePricePesewas / 100).toFixed(2);
}

export default function RecordCustomerReturnModal({
  customerId, customerName, onClose, onRecorded,
}: Props): JSX.Element {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [refundMethod, setRefundMethod] = useState<CustomerReturnRefundMethod>('CASH');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [productPick, setProductPick] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinPrompt, setPinPrompt] = useState<{
    reason: string;
    context: Record<string, unknown>;
    onApproved: (approvalId: string) => Promise<void>;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const r = await counter.listProducts();
      if (r.success) setProducts(r.data.products);
    })();
  }, []);

  function addLine(p: ProductSummary) {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.productId === p.id);
      if (i >= 0) {
        const next = prev.slice();
        next[i] = { ...next[i], quantity: next[i].quantity + 1 };
        return next;
      }
      return [...prev, {
        productId: p.id, productName: p.name,
        quantity: 1, refundUnitCedis: defaultRefundCedis(p), notes: '',
      }];
    });
  }
  function updateLine(id: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => l.productId === id ? { ...l, ...patch } : l));
  }
  function removeLine(id: string) {
    setLines((prev) => prev.filter((l) => l.productId !== id));
  }

  const total = lines.reduce((s, l) => {
    try { return s + parseCedisToPesewas(l.refundUnitCedis) * l.quantity; }
    catch { return s; }
  }, 0);

  async function recordCore(approvalId: string) {
    const lineInputs: CustomerReturnLineInputDto[] = [];
    for (const l of lines) {
      let unitPesewas: number;
      try { unitPesewas = parseCedisToPesewas(l.refundUnitCedis); }
      catch { setError(`Invalid refund price on ${l.productName}.`); return; }
      lineInputs.push({
        productId: l.productId, quantity: l.quantity,
        refundUnitPesewas: unitPesewas,
        notes: l.notes.trim() || undefined,
      });
    }
    setBusy(true);
    const r = await counter.customerReturnRecord({
      customerId, refundMethod,
      supervisorApprovalId: approvalId,
      lines: lineInputs,
      notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    onRecorded(r.data.customerReturnId, r.data.totalRefundPesewas);
  }

  function submit() {
    setError(null);
    if (lines.length === 0) { setError('Add at least one product.'); return; }
    if (total <= 0) { setError('Total refund must be greater than zero.'); return; }
    setPinPrompt({
      reason: `Approve customer return of ₵${formatMoney(total)} (${refundMethod}) for ${customerName}.`,
      context: {
        customerId, customerName,
        refundMethod, totalPesewas: total,
        lineCount: lines.length,
      },
      onApproved: async (approvalId) => {
        setPinPrompt(null);
        await recordCore(approvalId);
      },
    });
  }

  const productMatches = products.filter((p) => {
    if (!productPick.trim()) return false;
    const q = productPick.toLowerCase().trim();
    return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
  }).slice(0, 6);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] overflow-auto">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">Record return: {customerName}</div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>
        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">{error}</div>
          )}

          <div className="space-y-1">
            <div className="text-xs text-text-secondary uppercase tracking-wider">Refund method</div>
            <div className="flex gap-1">
              {(['CASH','CREDIT'] as CustomerReturnRefundMethod[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setRefundMethod(m)}
                  className={[
                    'flex-1 px-3 py-2 text-sm border',
                    refundMethod === m ? 'bg-accent text-bg-deep border-accent' : 'border-border hover:bg-bg-elevated',
                  ].join(' ')}
                >{m}</button>
              ))}
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              {refundMethod === 'CASH'
                ? 'Hands cash back to the customer from the till.'
                : 'Reduces the customer outstanding credit balance (FIFO against oldest open sales).'}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs text-text-secondary uppercase tracking-wider">Lines</div>
            {lines.length === 0 && (
              <div className="text-xs text-text-tertiary">Search a product below to add a return line.</div>
            )}
            {lines.map((l) => (
              <div key={l.productId} className="flex items-center gap-2 bg-bg-elevated px-2 py-1 border border-border">
                <div className="flex-1 text-sm truncate">{l.productName}</div>
                <input
                  type="number" min="1" value={l.quantity}
                  onChange={(e) => updateLine(l.productId, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                  className="w-16 bg-bg-deep border border-border px-2 py-1 text-sm font-mono tnum text-center" />
                <span className="text-xs text-text-tertiary">×</span>
                <input
                  value={l.refundUnitCedis}
                  onChange={(e) => updateLine(l.productId, { refundUnitCedis: e.target.value })}
                  className="w-20 bg-bg-deep border border-border px-2 py-1 text-sm font-mono tnum text-right" />
                <span className="text-xs text-text-tertiary">₵</span>
                <button onClick={() => removeLine(l.productId)} className="text-text-tertiary hover:text-danger text-sm px-1">×</button>
              </div>
            ))}
            <div className="relative">
              <input
                value={productPick}
                onChange={(e) => setProductPick(e.target.value)}
                placeholder="Search products to add…"
                className="w-full bg-bg-deep border border-border px-3 py-2 text-sm" />
              {productMatches.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-bg-surface border border-border z-10 max-h-48 overflow-auto shadow">
                  {productMatches.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { addLine(p); setProductPick(''); }}
                      className="block w-full text-left px-3 py-2 hover:bg-bg-elevated text-sm border-b border-border"
                    >
                      <div>{p.name}</div>
                      <div className="text-xs text-text-tertiary font-mono tnum">
                        {p.sku} · default ₵{formatMoney(p.wholesalePricePesewas)}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {lines.length > 0 && (
            <div className="border-t border-border pt-3 flex items-baseline justify-between">
              <span className="text-xs text-text-secondary uppercase tracking-wider">Total refund</span>
              <span className="font-mono tnum text-lg">₵{formatMoney(total)}</span>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Notes (optional)</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
              placeholder="e.g. short-dated stock, wrong product delivered" />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} disabled={busy}
              className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated disabled:opacity-50">Cancel</button>
            <button onClick={() => submit()} disabled={busy || lines.length === 0 || total <= 0}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50">
              {busy ? 'Recording…' : 'Record return'}
            </button>
          </div>
        </div>
      </div>

      {pinPrompt && (
        <SupervisorPinModal
          purpose="CUSTOMER_RETURN"
          reason={pinPrompt.reason}
          context={pinPrompt.context}
          onClose={() => setPinPrompt(null)}
          onApproved={(resp) => { void pinPrompt.onApproved(resp.approvalId); }}
        />
      )}
    </div>
  );
}
