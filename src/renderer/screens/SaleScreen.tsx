// SaleScreen — ring up a sale.
//
// Layout: left panel = product list + search; right panel = cart
// (lines with qty stepper) + total + customer picker + payment method
// + cash tendered. Bottom = Complete Sale.

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../lib/ipc';
import {
  formatMoney, formatMoneyWithCurrency, parseCedisToPesewas,
} from '../../shared/lib/money';
import type {
  ProductSummary, CustomerSummary, SaleLineInput,
} from '../../shared/types/ipc';

interface Props { onDone: () => void }

type Channel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
type PaymentMethod = 'CASH' | 'MOMO' | 'BANK' | 'CREDIT';

interface CartLine extends SaleLineInput {
  productName: string;
}

function priceFor(product: ProductSummary, channel: Channel): number {
  if (channel === 'WALK_IN')   return product.walkInPricePesewas;
  if (channel === 'WHOLESALE') return product.wholesalePricePesewas;
  return product.routePricePesewas;
}

export default function SaleScreen({ onDone }: Props): JSX.Element {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState<Channel>('WALK_IN');
  const [customerId, setCustomerId] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [cashTendered, setCashTendered] = useState<string>('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await counter.listProducts();
      if (r.success) setProducts(r.data.products);
      const c = await counter.listCustomers({});
      if (c.success) setCustomers(c.data.customers);
    })();
  }, []);

  // When channel changes, re-price all lines using the new channel's
  // price. The shopkeeper expects the cart to follow the channel they
  // pick.
  useEffect(() => {
    setCart((prev) => prev.map((line) => {
      const p = products.find((x) => x.id === line.productId);
      if (!p) return line;
      return { ...line, unitPricePesewas: priceFor(p, channel) };
    }));
  }, [channel, products]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return products;
    return products.filter(
      (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q),
    );
  }, [search, products]);

  function addToCart(p: ProductSummary) {
    setCart((prev) => {
      const existing = prev.find((l) => l.productId === p.id);
      if (existing) {
        return prev.map((l) =>
          l.productId === p.id ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [
        ...prev,
        {
          productId: p.id,
          productName: p.name,
          quantity: 1,
          unitPricePesewas: priceFor(p, channel),
          unitCostPesewas: p.costPricePesewas,
        },
      ];
    });
  }

  function setQty(productId: string, qty: number) {
    if (qty <= 0) {
      setCart((prev) => prev.filter((l) => l.productId !== productId));
      return;
    }
    setCart((prev) => prev.map((l) =>
      l.productId === productId ? { ...l, quantity: qty } : l,
    ));
  }

  const total = cart.reduce((s, l) => s + l.unitPricePesewas * l.quantity, 0);

  // Suggested cash tendered = total rounded up to nearest cedi (for
  // change-making convenience). User can override.
  const suggestedTendered = Math.ceil(total / 100) * 100;
  useEffect(() => {
    if (paymentMethod === 'CASH' && !cashTendered && total > 0) {
      setCashTendered((suggestedTendered / 100).toFixed(2));
    }
  }, [total, paymentMethod, suggestedTendered, cashTendered]);

  async function complete() {
    setError(null);
    if (cart.length === 0) {
      setError('Add at least one product before completing the sale.');
      return;
    }
    if (paymentMethod === 'CREDIT' && !customerId) {
      setError('Credit sales require a customer.');
      return;
    }

    let cashTenderedPesewas: number | undefined;
    if (paymentMethod === 'CASH') {
      try {
        cashTenderedPesewas = parseCedisToPesewas(cashTendered || '0');
      } catch (e: any) {
        setError(e?.message ?? 'Could not parse cash tendered.');
        return;
      }
      if (cashTenderedPesewas < total) {
        setError(`Cash tendered (₵${formatMoney(cashTenderedPesewas)}) is less than total (₵${formatMoney(total)}).`);
        return;
      }
    }

    setBusy(true);
    const r = await counter.createSale({
      channel,
      customerId: customerId || null,
      lines: cart.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        unitPricePesewas: l.unitPricePesewas,
        unitCostPesewas: l.unitCostPesewas,
      })),
      paymentMethod,
      cashTenderedPesewas,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    if (paymentMethod === 'CASH' && r.data.changePesewas > 0) {
      window.alert(`Sale complete. Change due: ₵${formatMoney(r.data.changePesewas)}`);
    } else {
      window.alert('Sale complete.');
    }
    onDone();
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="flex items-baseline justify-between px-6 py-4 border-b border-border bg-bg-surface">
        <div className="text-xl font-semibold tracking-tight">New sale</div>
        <button onClick={onDone} className="text-sm text-text-tertiary hover:text-text-primary">
          Cancel
        </button>
      </header>

      <div className="flex-1 grid grid-cols-2 gap-4 p-4 overflow-hidden">
        {/* Left: product picker */}
        <div className="bg-bg-surface border border-border flex flex-col min-h-0">
          <div className="p-3 border-b border-border">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              placeholder="Search products by name or SKU…"
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
            />
          </div>
          <div className="flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <div className="p-4 text-text-tertiary text-sm">No matches.</div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {filtered.map((p, i) => (
                    <tr
                      key={p.id}
                      className={`hover:bg-bg-elevated cursor-pointer ${i > 0 ? 'border-t border-border' : ''}`}
                      onClick={() => addToCart(p)}
                    >
                      <td className="px-3 py-2">
                        <div>{p.name}</div>
                        <div className="text-xs text-text-tertiary font-mono tnum">{p.sku}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tnum">
                        {formatMoneyWithCurrency(priceFor(p, channel))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right: cart + sale config */}
        <div className="bg-bg-surface border border-border flex flex-col min-h-0">
          <div className="p-3 border-b border-border flex flex-col gap-3">
            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Channel</div>
              <div className="flex gap-1">
                {(['WALK_IN', 'WHOLESALE', 'ROUTE'] as Channel[]).map((c) => (
                  <button
                    key={c}
                    onClick={() => setChannel(c)}
                    className={[
                      'px-3 py-1 text-xs border',
                      channel === c
                        ? 'bg-accent text-bg-deep border-accent'
                        : 'border-border hover:bg-bg-elevated',
                    ].join(' ')}
                  >
                    {c.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Customer (optional)</div>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
              >
                <option value="">— Walk-in / no customer —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} ({c.customerType})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Cart */}
          <div className="flex-1 overflow-auto">
            {cart.length === 0 ? (
              <div className="p-4 text-text-tertiary text-sm">
                Click a product on the left to add it to the cart.
              </div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {cart.map((l, i) => (
                    <tr key={l.productId} className={i > 0 ? 'border-t border-border' : ''}>
                      <td className="px-3 py-2">
                        <div>{l.productName}</div>
                        <div className="text-xs text-text-tertiary font-mono tnum">
                          @ ₵{formatMoney(l.unitPricePesewas)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={() => setQty(l.productId, l.quantity - 1)}
                            className="w-6 h-6 border border-border hover:bg-bg-elevated"
                          >−</button>
                          <span className="font-mono tnum w-8 text-center">{l.quantity}</span>
                          <button
                            onClick={() => setQty(l.productId, l.quantity + 1)}
                            className="w-6 h-6 border border-border hover:bg-bg-elevated"
                          >+</button>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tnum">
                        ₵{formatMoney(l.unitPricePesewas * l.quantity)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Totals + payment */}
          <div className="p-3 border-t border-border space-y-3">
            <div className="flex items-baseline justify-between">
              <div className="text-text-secondary uppercase text-xs tracking-wider">Total</div>
              <div className="font-mono tnum text-2xl">{formatMoneyWithCurrency(total)}</div>
            </div>

            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Payment</div>
              <div className="flex gap-1">
                {(['CASH', 'MOMO', 'BANK', 'CREDIT'] as PaymentMethod[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setPaymentMethod(m)}
                    className={[
                      'px-3 py-1 text-xs border',
                      paymentMethod === m
                        ? 'bg-accent text-bg-deep border-accent'
                        : 'border-border hover:bg-bg-elevated',
                    ].join(' ')}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {paymentMethod === 'CASH' && total > 0 && (
              <div className="flex items-baseline gap-2">
                <label className="text-xs text-text-secondary uppercase tracking-wider">Cash tendered</label>
                <input
                  value={cashTendered}
                  onChange={(e) => setCashTendered(e.target.value)}
                  className="flex-1 bg-bg-deep border border-border px-3 py-1 text-sm font-mono tnum"
                  placeholder="0.00"
                />
                <span className="text-text-tertiary text-xs">
                  change: ₵{(() => {
                    try {
                      return formatMoney(parseCedisToPesewas(cashTendered || '0') - total);
                    } catch { return '—'; }
                  })()}
                </span>
              </div>
            )}

            {error && (
              <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
                {error}
              </div>
            )}

            <button
              onClick={() => void complete()}
              disabled={busy || cart.length === 0}
              className="w-full bg-accent text-bg-deep font-semibold px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? 'Completing…' : 'Complete sale'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
