// StockScreen — On Hand view + Receive form. Clears the tier-1 inventory
// gap: shop can now see what's in stock and add stock from a delivery.

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import {
  formatMoney, formatMoneyWithCurrency, parseCedisToPesewas,
} from '../../shared/lib/money';
import type { ProductSummary } from '../../shared/types/ipc';

interface OnHandRow {
  productId: string;
  productName: string;
  sku: string;
  category: string | null;
  onHand: number;
  reorderThreshold: number;
  reorderQuantity: number;
  costPricePesewas: number;
}

interface Props { onBack: () => void }
type Tab = 'on-hand' | 'receive';

export default function StockScreen({ onBack }: Props): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';
  const [tab, setTab] = useState<Tab>('on-hand');

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-baseline justify-between px-6 py-4 border-b border-border bg-bg-surface">
        <div className="flex items-baseline gap-4">
          <button onClick={onBack} className="text-text-tertiary hover:text-text-primary text-sm">
            ← Home
          </button>
          <div className="text-xl font-semibold tracking-tight">Stock</div>
        </div>
      </header>
      <div className="px-6 pt-3 border-b border-border bg-bg-surface flex gap-1">
        <TabBtn active={tab === 'on-hand'} onClick={() => setTab('on-hand')}>On hand</TabBtn>
        <TabBtn active={tab === 'receive'} onClick={() => setTab('receive')} disabled={!isOwner}>
          Receive
        </TabBtn>
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'on-hand' && <OnHandTab />}
        {tab === 'receive' && (isOwner
          ? <ReceiveTab onDone={() => setTab('on-hand')} />
          : <div className="p-6 text-text-tertiary text-sm">OWNER role required to receive stock.</div>)}
      </div>
    </div>
  );
}

function OnHandTab(): JSX.Element {
  const [rows, setRows] = useState<OnHandRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const r = await counter.stockOnHand({});
      if (!r.success) setError(r.error);
      else setRows(r.data.rows);
    })();
  }, []);

  return (
    <div className="p-6">
      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded mb-4">
          {error}
        </div>
      )}
      <table className="w-full text-sm bg-bg-surface border border-border">
        <thead>
          <tr className="text-text-secondary uppercase tracking-wider text-xs">
            <th className="px-4 py-2 text-left">Product</th>
            <th className="px-4 py-2 text-left">SKU</th>
            <th className="px-4 py-2 text-right">On hand</th>
            <th className="px-4 py-2 text-right">Reorder at</th>
            <th className="px-4 py-2 text-right">Reorder qty</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const negative = r.onHand < 0;
            const low = !negative && r.onHand <= r.reorderThreshold;
            return (
              <tr key={r.productId} className="border-t border-border">
                <td className="px-4 py-2">{r.productName}</td>
                <td className="px-4 py-2 font-mono tnum text-text-tertiary">{r.sku}</td>
                <td className={[
                  'px-4 py-2 text-right font-mono tnum',
                  negative ? 'text-danger font-semibold' : low ? 'text-warning' : '',
                ].join(' ')}>
                  {r.onHand}
                  {negative && <span className="text-xs ml-2">(receive!)</span>}
                  {low && !negative && <span className="text-xs ml-2">(low)</span>}
                </td>
                <td className="px-4 py-2 text-right font-mono tnum text-text-tertiary">{r.reorderThreshold}</td>
                <td className="px-4 py-2 text-right font-mono tnum text-text-tertiary">{r.reorderQuantity}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={5} className="px-4 py-6 text-center text-text-tertiary">No products.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface ReceiveLine {
  productId: string;
  productName: string;
  qty: string;
  unitCostCedis: string;
}

function ReceiveTab({ onDone }: { onDone: () => void }): JSX.Element {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [lines, setLines] = useState<ReceiveLine[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await counter.listProducts();
      if (r.success) setProducts(r.data.products);
    })();
  }, []);

  const total = useMemo(() => {
    return lines.reduce((s, l) => {
      const q = parseInt(l.qty, 10) || 0;
      let c = 0;
      try { c = parseCedisToPesewas(l.unitCostCedis || '0'); } catch { c = 0; }
      return s + q * c;
    }, 0);
  }, [lines]);

  function addProduct(p: ProductSummary) {
    setLines((prev) => {
      if (prev.find((l) => l.productId === p.id)) return prev;
      return [...prev, {
        productId: p.id,
        productName: p.name,
        qty: '1',
        unitCostCedis: (p.costPricePesewas / 100).toFixed(2),
      }];
    });
    setPickerOpen(false);
  }

  function setLine(productId: string, patch: Partial<ReceiveLine>) {
    setLines((prev) => prev.map((l) =>
      l.productId === productId ? { ...l, ...patch } : l,
    ));
  }
  function remove(productId: string) {
    setLines((prev) => prev.filter((l) => l.productId !== productId));
  }

  async function submit() {
    setError(null);
    if (lines.length === 0) {
      setError('Add at least one line.'); return;
    }
    const built: { productId: string; quantity: number; unitCostPesewas: number }[] = [];
    try {
      for (const l of lines) {
        const qty = parseInt(l.qty, 10);
        const cost = parseCedisToPesewas(l.unitCostCedis || '0');
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error(`Quantity for "${l.productName}" must be a positive integer.`);
        }
        built.push({ productId: l.productId, quantity: qty, unitCostPesewas: cost });
      }
    } catch (e: any) {
      setError(e?.message ?? 'Could not parse a line.'); return;
    }
    setBusy(true);
    const r = await counter.receiveStock({ lines: built });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    window.alert(
      `Receipt recorded.\n\n` +
      `${r.data.lineCount} line${r.data.lineCount === 1 ? '' : 's'}, ` +
      `${r.data.totalUnits} unit${r.data.totalUnits === 1 ? '' : 's'} added to stock.`,
    );
    setLines([]);
    onDone();
  }

  return (
    <div className="p-6 space-y-4">
      <div className="text-sm text-text-tertiary">
        Record what came in from the supplier today. Each line: pick a product,
        enter quantity received, enter the unit cost paid (cedis). The unit cost
        snapshots into <span className="font-mono tnum">stock_movements</span> for
        margin reporting.
      </div>

      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}

      <div className="bg-bg-surface border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-secondary uppercase tracking-wider text-xs">
              <th className="px-4 py-2 text-left">Product</th>
              <th className="px-4 py-2 text-right">Qty received</th>
              <th className="px-4 py-2 text-right">Unit cost (₵)</th>
              <th className="px-4 py-2 text-right">Line total</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const q = parseInt(l.qty, 10) || 0;
              let lineTotal = 0;
              try { lineTotal = q * parseCedisToPesewas(l.unitCostCedis || '0'); } catch {}
              return (
                <tr key={l.productId} className={i > 0 ? 'border-t border-border' : ''}>
                  <td className="px-4 py-2">{l.productName}</td>
                  <td className="px-4 py-2 text-right">
                    <input
                      type="number"
                      min="1"
                      value={l.qty}
                      onChange={(e) => setLine(l.productId, { qty: e.target.value })}
                      className="w-20 bg-bg-deep border border-border px-2 py-1 text-right text-sm font-mono tnum"
                    />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <input
                      value={l.unitCostCedis}
                      onChange={(e) => setLine(l.productId, { unitCostCedis: e.target.value })}
                      className="w-24 bg-bg-deep border border-border px-2 py-1 text-right text-sm font-mono tnum"
                    />
                  </td>
                  <td className="px-4 py-2 text-right font-mono tnum">{formatMoneyWithCurrency(lineTotal)}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => remove(l.productId)}
                      className="text-text-tertiary hover:text-danger text-sm">×</button>
                  </td>
                </tr>
              );
            })}
            {lines.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-4 text-center text-text-tertiary text-sm">
                No lines yet — click "Add product" below.
              </td></tr>
            )}
          </tbody>
        </table>
        <div className="border-t border-border px-4 py-2 flex items-baseline justify-between">
          <button
            onClick={() => setPickerOpen(true)}
            className="text-sm px-3 py-1 border border-accent text-accent hover:bg-accent hover:text-bg-deep"
          >
            + Add product
          </button>
          <div className="text-sm">
            Total: <span className="font-mono tnum">{formatMoneyWithCurrency(total)}</span>
          </div>
        </div>
      </div>

      <button
        onClick={() => void submit()}
        disabled={busy || lines.length === 0}
        className="bg-accent text-bg-deep font-semibold px-4 py-2 disabled:opacity-50"
      >
        {busy ? 'Recording…' : 'Record receipt'}
      </button>

      {pickerOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50"
             onClick={() => setPickerOpen(false)}>
          <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md max-h-[80vh] overflow-auto"
               onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-border font-semibold">Pick a product</div>
            <table className="w-full text-sm">
              <tbody>
                {products
                  .filter((p) => !lines.find((l) => l.productId === p.id))
                  .map((p) => (
                    <tr key={p.id} className="border-t border-border first:border-t-0 hover:bg-bg-elevated cursor-pointer"
                        onClick={() => addProduct(p)}>
                      <td className="px-4 py-2">{p.name}</td>
                      <td className="px-4 py-2 text-right text-text-tertiary text-xs font-mono tnum">
                        cost ₵{formatMoney(p.costPricePesewas)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, disabled, children }: {
  active: boolean; onClick?: () => void; disabled?: boolean; children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? 'OWNER role required' : ''}
      className={[
        'px-4 py-2 text-sm border-b-2 -mb-px',
        active ? 'border-accent text-accent'
               : disabled
                 ? 'border-transparent text-text-tertiary opacity-50 cursor-not-allowed'
                 : 'border-transparent text-text-tertiary hover:text-text-primary',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
