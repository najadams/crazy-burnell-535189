// SettingsPromotions — manage bonus-unit promotions (Wave D).
//
// OWNER-only writes; list visible to all signed-in workers so any
// cashier can sanity-check which promos are currently active. Each
// promo is "buy N of P (on channel C), get M free". Bonus lines are
// computed automatically at sale time via createSale.

import { useEffect, useState } from 'react';
import { useSession } from '../store/session';
import { counter } from '../lib/ipc';
import type {
  PromotionRowDto, PromotionChannel, ProductSummary,
} from '../../shared/types/ipc';

function todayDate(): string { return new Date().toISOString().slice(0, 10); }

export default function SettingsPromotions(): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwnerLike = role === 'OWNER' || role === 'FOUNDER';

  const [promos, setPromos] = useState<PromotionRowDto[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-promo form
  const [productId, setProductId] = useState('');
  const [channel, setChannel] = useState<PromotionChannel | ''>('');
  const [qtyBuy, setQtyBuy] = useState('12');
  const [qtyGetFree, setQtyGetFree] = useState('1');
  const [validFrom, setValidFrom] = useState(todayDate());
  const [validTo, setValidTo] = useState('');

  async function refresh() {
    const r = await counter.promotionList({ includeArchived: showArchived });
    if (r.success) setPromos(r.data.promotions);
    else setError(r.error);
  }
  useEffect(() => { void refresh(); }, [showArchived]);
  useEffect(() => {
    (async () => {
      const p = await counter.listProducts();
      if (p.success) setProducts(p.data.products);
    })();
  }, []);

  async function submitCreate() {
    setError(null);
    if (!productId) { setError('Pick a product.'); return; }
    const buy = parseInt(qtyBuy, 10);
    const get = parseInt(qtyGetFree, 10);
    if (!Number.isFinite(buy) || buy <= 0) { setError('qty_buy must be > 0.'); return; }
    if (!Number.isFinite(get) || get <= 0) { setError('qty_get_free must be > 0.'); return; }
    setBusy(true);
    const r = await counter.promotionCreate({
      productId,
      channel: channel || null,
      qtyBuy: buy,
      qtyGetFree: get,
      validFrom,
      validTo: validTo || null,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    // Reset form
    setProductId(''); setChannel(''); setQtyBuy('12'); setQtyGetFree('1');
    setValidFrom(todayDate()); setValidTo('');
    await refresh();
  }

  async function archive(id: string) {
    if (!window.confirm('Archive this promotion? It will stop applying immediately.')) return;
    const r = await counter.promotionArchive({ promotionId: id });
    if (!r.success) { setError(r.error); return; }
    await refresh();
  }
  async function reactivate(id: string) {
    const r = await counter.promotionReactivate({ promotionId: id });
    if (!r.success) { setError(r.error); return; }
    await refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-lg font-semibold">Bonus-unit promotions</div>
        <div className="text-sm text-text-tertiary mt-1">
          "Buy N of a product, get M free." Applied automatically at
          sale time: a BONUS line is added with the free units priced
          at zero. Cost still flows through (negative margin) so
          rebate claims from anchor brands are forensically defensible.
          Greedy on the largest qty_buy that fits — a 12-buy promo is
          preferred over a 6-buy promo for 18 crates.
        </div>
      </div>

      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">{error}</div>
      )}

      <div className="flex items-baseline justify-between">
        <div className="text-sm font-semibold">All promotions</div>
        <label className="text-xs text-text-tertiary flex items-center gap-1">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {promos.length === 0 ? (
        <div className="text-sm text-text-tertiary">No promotions yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-tertiary text-xs uppercase tracking-wider">
              <th className="text-left py-1">Product</th>
              <th className="text-left py-1">Channel</th>
              <th className="text-right py-1">Buy</th>
              <th className="text-right py-1">Get free</th>
              <th className="text-left py-1">Valid</th>
              <th className="text-right py-1"></th>
            </tr>
          </thead>
          <tbody>
            {promos.map((p) => (
              <tr key={p.id} className="border-t border-border">
                <td className="py-1">{p.productName}</td>
                <td className="py-1">{p.channel ?? 'any'}</td>
                <td className="py-1 text-right font-mono tnum">{p.qtyBuy}</td>
                <td className="py-1 text-right font-mono tnum">{p.qtyGetFree}</td>
                <td className="py-1 text-xs text-text-tertiary font-mono tnum">
                  {p.validFrom}{p.validTo ? ` → ${p.validTo}` : ' →'}
                </td>
                <td className="py-1 text-right">
                  {isOwnerLike && (p.active
                    ? <button onClick={() => void archive(p.id)} className="text-xs px-2 py-0.5 border border-warning text-warning hover:bg-warning hover:text-bg-deep">Archive</button>
                    : <button onClick={() => void reactivate(p.id)} className="text-xs px-2 py-0.5 border border-accent text-accent hover:bg-accent hover:text-bg-deep">Reactivate</button>
                  )}
                  {!p.active && <span className="text-xs text-text-tertiary ml-2">archived</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isOwnerLike && (
        <div className="border-t border-border pt-4 space-y-2">
          <div className="text-sm font-semibold">New promotion</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Product</label>
              <select value={productId} onChange={(e) => setProductId(e.target.value)}
                className="w-full bg-bg-deep border border-border px-2 py-1 text-sm">
                <option value="">— pick product —</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Channel (optional)</label>
              <select value={channel} onChange={(e) => setChannel(e.target.value as PromotionChannel | '')}
                className="w-full bg-bg-deep border border-border px-2 py-1 text-sm">
                <option value="">any channel</option>
                <option value="WALK_IN">WALK_IN</option>
                <option value="WHOLESALE">WHOLESALE</option>
                <option value="ROUTE">ROUTE</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">qty_buy</label>
              <input value={qtyBuy} onChange={(e) => setQtyBuy(e.target.value)} inputMode="numeric"
                className="w-full bg-bg-deep border border-border px-2 py-1 text-sm font-mono tnum text-center" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">qty_get_free</label>
              <input value={qtyGetFree} onChange={(e) => setQtyGetFree(e.target.value)} inputMode="numeric"
                className="w-full bg-bg-deep border border-border px-2 py-1 text-sm font-mono tnum text-center" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">valid_from</label>
              <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)}
                className="w-full bg-bg-deep border border-border px-2 py-1 text-sm font-mono tnum" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">valid_to (optional)</label>
              <input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)}
                className="w-full bg-bg-deep border border-border px-2 py-1 text-sm font-mono tnum" />
            </div>
          </div>
          <button onClick={() => void submitCreate()} disabled={busy}
            className="mt-2 text-sm px-3 py-2 border border-accent text-accent hover:bg-accent hover:text-bg-deep disabled:opacity-50">
            {busy ? 'Creating…' : 'Create promotion'}
          </button>
        </div>
      )}
    </div>
  );
}
