// NewPendingOrderModal — capture a phone/manual/WhatsApp order.
//
// Fields: customer (required), intake channel, line items (product +
// quantity + per-unit price), requires-review flag. On submit calls
// counter.pendingOrderCreate and notifies the parent.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import {
  formatMoney, parseCedisToPesewas,
} from '../../shared/lib/money';
import type {
  CustomerSummary, ProductSummary,
  PendingOrderIntakeChannel, PendingOrderLineInputDto,
} from '../../shared/types/ipc';

interface Props {
  onClose: () => void;
  onCreated: (pendingOrderId: string) => void;
}

interface DraftLine {
  productId: string;
  productName: string;
  quantity: number;
  unitPriceCedis: string;            // user-entered, parsed on submit
  notes: string;
}

const CHANNEL_LABELS: Record<PendingOrderIntakeChannel, string> = {
  PHONE_CALL:    'Phone call',
  MANUAL:        'In person / standing',
  WHATSAPP_TEXT: 'WhatsApp message',
};

function defaultPriceCedis(p: ProductSummary): string {
  // The wholesale channel is the dominant route-distribution price
  // point; route_price would be more accurate once routes ship but
  // for now this is a reasonable default the depot lead can override.
  return (p.wholesalePricePesewas / 100).toFixed(2);
}

export default function NewPendingOrderModal({
  onClose, onCreated,
}: Props): JSX.Element {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [channel, setChannel] = useState<PendingOrderIntakeChannel>('PHONE_CALL');
  const [requiresReview, setRequiresReview] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [productPick, setProductPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const p = await counter.listProducts();
      if (p.success) setProducts(p.data.products);
      const c = await counter.listCustomers({});
      if (c.success) setCustomers(c.data.customers);
    })();
  }, []);

  function addLine(p: ProductSummary) {
    setLines((prev) => {
      // Merge into existing line if same product already in list.
      const i = prev.findIndex((l) => l.productId === p.id);
      if (i >= 0) {
        const next = prev.slice();
        next[i] = { ...next[i], quantity: next[i].quantity + 1 };
        return next;
      }
      return [...prev, {
        productId: p.id, productName: p.name,
        quantity: 1, unitPriceCedis: defaultPriceCedis(p), notes: '',
      }];
    });
  }
  function removeLine(productId: string) {
    setLines((prev) => prev.filter((l) => l.productId !== productId));
  }
  function updateLine(productId: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => l.productId === productId ? { ...l, ...patch } : l));
  }

  const lineSubtotal = lines.reduce((s, l) => {
    try { return s + parseCedisToPesewas(l.unitPriceCedis) * l.quantity; }
    catch { return s; }
  }, 0);

  async function submit() {
    setError(null);
    if (!customerId) { setError('Pick a customer.'); return; }
    if (lines.length === 0) { setError('Add at least one product.'); return; }

    const lineInputs: PendingOrderLineInputDto[] = [];
    for (const l of lines) {
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
        setError(`Invalid quantity on ${l.productName}.`); return;
      }
      let unitPricePesewas: number;
      try {
        unitPricePesewas = parseCedisToPesewas(l.unitPriceCedis);
      } catch { setError(`Invalid price on ${l.productName}.`); return; }
      lineInputs.push({
        productId: l.productId, quantity: l.quantity,
        unitPricePesewasAtIntake: unitPricePesewas,
        notes: l.notes.trim() || undefined,
      });
    }

    setBusy(true);
    const r = await counter.pendingOrderCreate({
      customerId,
      intakeChannel: channel,
      requiresReview,
      lines: lineInputs,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    onCreated(r.data.pendingOrderId);
  }

  const productMatches = products.filter((p) => {
    if (!productPick.trim()) return false;
    const q = productPick.toLowerCase().trim();
    return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
  }).slice(0, 6);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">New pending order</div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Customer</label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
              >
                <option value="">— pick customer —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} ({c.customerType})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Intake channel</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as PendingOrderIntakeChannel)}
                className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
              >
                {(['PHONE_CALL','MANUAL','WHATSAPP_TEXT'] as PendingOrderIntakeChannel[]).map((c) => (
                  <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>
                ))}
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={requiresReview}
              onChange={(e) => setRequiresReview(e.target.checked)}
            />
            Flag for review (quantity spike, unfamiliar customer, anything off)
          </label>

          <div className="space-y-2">
            <div className="text-xs text-text-secondary uppercase tracking-wider">Lines</div>
            {lines.length === 0 && (
              <div className="text-xs text-text-tertiary">No lines yet — search a product below.</div>
            )}
            {lines.map((l) => (
              <div key={l.productId} className="flex items-center gap-2 bg-bg-elevated px-2 py-1 border border-border">
                <div className="flex-1 text-sm truncate">{l.productName}</div>
                <input
                  type="number"
                  min="1"
                  value={l.quantity}
                  onChange={(e) => updateLine(l.productId, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                  className="w-16 bg-bg-deep border border-border px-2 py-1 text-sm font-mono tnum text-center"
                />
                <span className="text-xs text-text-tertiary">×</span>
                <input
                  value={l.unitPriceCedis}
                  onChange={(e) => updateLine(l.productId, { unitPriceCedis: e.target.value })}
                  className="w-20 bg-bg-deep border border-border px-2 py-1 text-sm font-mono tnum text-right"
                />
                <span className="text-xs text-text-tertiary">₵</span>
                <button
                  onClick={() => removeLine(l.productId)}
                  className="text-text-tertiary hover:text-danger text-sm px-1"
                  title="Remove"
                >×</button>
              </div>
            ))}
            <div className="relative">
              <input
                value={productPick}
                onChange={(e) => setProductPick(e.target.value)}
                placeholder="Search products to add…"
                className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
              />
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
              <span className="text-xs text-text-secondary uppercase tracking-wider">Subtotal at intake</span>
              <span className="font-mono tnum text-lg">₵{formatMoney(lineSubtotal)}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} disabled={busy}
              className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated disabled:opacity-50"
            >Cancel</button>
            <button
              onClick={() => void submit()}
              disabled={busy || !customerId || lines.length === 0}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Save order'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
