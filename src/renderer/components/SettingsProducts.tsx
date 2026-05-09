// SettingsProducts — list current products and add new ones.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import {
  formatMoney, parseCedisToPesewas,
} from '../../shared/lib/money';
import type { ProductSummary } from '../../shared/types/ipc';

export default function SettingsProducts(): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [adding, setAdding] = useState(false);

  async function refresh() {
    const r = await counter.listProducts();
    if (r.success) setProducts(r.data.products);
  }
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-lg font-semibold">Products</div>
          <div className="text-sm text-text-tertiary mt-1">
            Add new SKUs as the catalog grows. Walk-in / wholesale / route prices
            are picked up automatically by the Sale screen based on channel.
          </div>
        </div>
        <button
          disabled={!isOwner}
          onClick={() => setAdding(true)}
          title={!isOwner ? 'OWNER role required' : ''}
          className={[
            'text-sm px-3 py-2 border',
            isOwner
              ? 'border-accent text-accent hover:bg-accent hover:text-bg-deep'
              : 'border-border text-text-tertiary opacity-60 cursor-not-allowed',
          ].join(' ')}
        >
          + Add product
        </button>
      </div>

      {adding && (
        <AddProductForm
          onCancel={() => setAdding(false)}
          onAdded={() => { setAdding(false); void refresh(); }}
        />
      )}

      <div className="bg-bg-surface border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-secondary uppercase tracking-wider text-xs">
              <th className="px-4 py-2 text-left">SKU</th>
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-right">Cost</th>
              <th className="px-4 py-2 text-right">Walk-in</th>
              <th className="px-4 py-2 text-right">Wholesale</th>
              <th className="px-4 py-2 text-right">Route</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-t border-border">
                <td className="px-4 py-2 font-mono tnum text-text-tertiary">{p.sku}</td>
                <td className="px-4 py-2">{p.name}</td>
                <td className="px-4 py-2 text-right font-mono tnum">₵{formatMoney(p.costPricePesewas)}</td>
                <td className="px-4 py-2 text-right font-mono tnum">₵{formatMoney(p.walkInPricePesewas)}</td>
                <td className="px-4 py-2 text-right font-mono tnum">₵{formatMoney(p.wholesalePricePesewas)}</td>
                <td className="px-4 py-2 text-right font-mono tnum">₵{formatMoney(p.routePricePesewas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddProductForm({ onCancel, onAdded }: {
  onCancel: () => void; onAdded: () => void;
}): JSX.Element {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [costCedis, setCostCedis] = useState('');
  const [walkInCedis, setWalkInCedis] = useState('');
  const [wholesaleCedis, setWholesaleCedis] = useState('');
  const [routeCedis, setRouteCedis] = useState('');
  const [reorderThreshold, setReorderThreshold] = useState('24');
  const [reorderQuantity, setReorderQuantity] = useState('120');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    try {
      const cost = parseCedisToPesewas(costCedis || '0');
      const walkIn = parseCedisToPesewas(walkInCedis || '0');
      const wholesale = parseCedisToPesewas(wholesaleCedis || costCedis || '0');
      const route = parseCedisToPesewas(routeCedis || costCedis || '0');
      const reThr = parseInt(reorderThreshold, 10) || 0;
      const reQty = parseInt(reorderQuantity, 10) || 0;
      if (!sku.trim() || !name.trim()) {
        setError('SKU and name are required.'); return;
      }
      setBusy(true);
      const r = await counter.createProduct({
        sku: sku.trim(),
        name: name.trim(),
        category: category.trim() || null,
        costPricePesewas: cost,
        walkInPricePesewas: walkIn,
        wholesalePricePesewas: wholesale,
        routePricePesewas: route,
        reorderThreshold: reThr,
        reorderQuantity: reQty,
        unitVolumeMl: null,
        isReturnable: false,
        bottleDepositPesewas: 0,
      });
      setBusy(false);
      if (!r.success) { setError(r.error); return; }
      onAdded();
    } catch (e: any) {
      setBusy(false);
      setError(e?.message ?? 'Could not parse a price.');
    }
  }

  return (
    <div className="bg-bg-surface border border-border p-4 space-y-3">
      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Field label="SKU"      value={sku}      onChange={setSku}      placeholder="e.g. CLUB-65" />
        <Field label="Name"     value={name}     onChange={setName}     placeholder="e.g. Club Beer 650ml" />
        <Field label="Category" value={category} onChange={setCategory} placeholder="optional" />
        <Field label="Cost (cedis)" value={costCedis} onChange={setCostCedis} placeholder="e.g. 6.50" mono />
        <Field label="Walk-in price"   value={walkInCedis}    onChange={setWalkInCedis}    mono />
        <Field label="Wholesale price" value={wholesaleCedis} onChange={setWholesaleCedis} mono />
        <Field label="Route price"     value={routeCedis}     onChange={setRouteCedis}     mono />
        <div /> {/* spacer */}
        <Field label="Reorder threshold" value={reorderThreshold} onChange={setReorderThreshold} mono />
        <Field label="Reorder quantity"  value={reorderQuantity}  onChange={setReorderQuantity}  mono />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated">
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Add product'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, mono = false }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; mono?: boolean;
}): JSX.Element {
  return (
    <div className="space-y-1">
      <label className="text-xs text-text-secondary">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-bg-deep border border-border px-3 py-2 text-sm ${mono ? 'font-mono tnum' : ''}`}
      />
    </div>
  );
}
