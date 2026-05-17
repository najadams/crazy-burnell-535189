// SaleScreen — ring up a sale.
//
// Layout: left panel = product list + search; right panel = cart
// + total + customer picker + multi-tender entry + summary. Bottom =
// Complete Sale.
//
// Payment model (after migration 0007): the cashier enters whatever
// the customer actually handed over per method — cash given, MoMo
// amount, bank amount. The screen computes:
//   paid  = min(handed-over total, sale total)
//   change = max(0, handed-over total − sale total)   (cash overpay)
//   on credit = max(0, sale total − handed-over total)
// On Complete sale: if credit > 0, a customer is required; if the
// resulting customer balance would exceed credit_limit, the
// SupervisorPinModal opens (purpose OVER_LIMIT_PARTIAL) and the
// returned approval id is threaded into createSale.
//
// Quantity-entry ergonomics (pre-deployment polish):
//   1. Each cart line's quantity cell is a direct integer input —
//      focus it and type. The −/+ buttons remain for one-off bumps,
//      but the input is the primary entry path for wholesale-sized
//      orders (e.g. 150 packs). Blur/Enter commits, Escape reverts.
//      Typing 0 removes the line (mirrors the existing setQty rule).
//   2. The search box accepts a trailing `*N` or `×N` multiplier —
//      typing `stout *24` filters by "stout" and queues 24 as the
//      quantity to add on the next click. A small hint surfaces the
//      pending multiplier so it's discoverable. Deliberately does NOT
//      match `xN` because the letter `x` collides with product names.
//   3. Pressing Enter in the search box adds the top filtered product
//      using the parsed multiplier (or 1 if none) and clears the box.
//      One-handed keyboard flow for long orders.

import { useEffect, useMemo, useRef, useState } from 'react';
import { counter } from '../lib/ipc';
import {
  formatMoney, formatMoneyWithCurrency, parseCedisToPesewas,
} from '../../shared/lib/money';
import type {
  ProductSummary, CustomerSummary, SaleLineInput,
  PaymentTenderInput,
} from '../../shared/types/ipc';
import SupervisorPinModal from '../components/SupervisorPinModal';
import { type ReceiptShop, type ReceiptData } from '../lib/printing';
import PrintableReceipt from '../components/PrintableReceipt';
import { useSession } from '../store/session';

interface Props { onDone: () => void }

type Channel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

interface CartLine extends SaleLineInput {
  productName: string;
}

function priceFor(product: ProductSummary, channel: Channel): number {
  if (channel === 'WALK_IN')   return product.walkInPricePesewas;
  if (channel === 'WHOLESALE') return product.wholesalePricePesewas;
  return product.routePricePesewas;
}

// Parse a search string with an optional trailing quantity multiplier.
// Matches `*N` or `×N` (with or without surrounding spaces) at the end
// of the input. The text portion is what the filter uses; the qty is
// what the next add-to-cart applies.
function parseSearchWithMultiplier(input: string): { text: string; qty: number } {
  const m = input.match(/^(.*?)\s*[×*]\s*(\d+)\s*$/);
  if (m) {
    const qty = parseInt(m[2], 10);
    if (Number.isFinite(qty) && qty > 0) {
      return { text: m[1].trim(), qty };
    }
  }
  return { text: input.trim(), qty: 1 };
}

// Quantity cell — direct integer entry with −/+ steppers on either
// side. Local string state so the user can type freely; commits on
// blur/Enter, reverts on Escape, strips non-digits as they type.
// Typing 0 (or stepping below 1) removes the line via setQty's rule.
function QtyCell({ value, onChange }: {
  value: number;
  onChange: (n: number) => void;
}): JSX.Element {
  const [text, setText] = useState<string>(String(value));

  // Resync when the canonical value changes from outside (−/+ clicks,
  // channel re-price, etc.). The line can also disappear entirely if
  // qty drops to 0 — in that case this component unmounts before this
  // effect runs.
  useEffect(() => { setText(String(value)); }, [value]);

  function commit() {
    if (text.trim() === '') { setText(String(value)); return; }
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < 0) { setText(String(value)); return; }
    onChange(n);
  }

  return (
    <div className="inline-flex items-center gap-1">
      <button
        onClick={() => onChange(value - 1)}
        className="w-6 h-6 border border-border hover:bg-bg-elevated"
        aria-label="Decrease quantity"
      >−</button>
      <input
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(String(value));
            (e.target as HTMLInputElement).blur();
          }
        }}
        onFocus={(e) => e.target.select()}
        inputMode="numeric"
        className="font-mono tnum w-14 text-center bg-bg-deep border border-border px-1 py-0.5"
        aria-label="Quantity"
      />
      <button
        onClick={() => onChange(value + 1)}
        className="w-6 h-6 border border-border hover:bg-bg-elevated"
        aria-label="Increase quantity"
      >+</button>
    </div>
  );
}

export default function SaleScreen({ onDone }: Props): JSX.Element {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState<Channel>('WALK_IN');
  const [customerId, setCustomerId] = useState<string>('');
  // Customer credit context — pre-fetched when customerId changes so
  // the over-limit check on complete doesn't require a round trip.
  const [customerCredit, setCustomerCredit] = useState<{
    creditLimitPesewas: number;
    currentBalancePesewas: number;
  } | null>(null);
  // Three tender inputs (cedi strings; parsed on submit). cashGiven
  // is what the customer handed over; momo/bank are amounts
  // transferred. Optional references for non-cash methods.
  const [cashGiven, setCashGiven] = useState<string>('');
  const [momoAmount, setMomoAmount] = useState<string>('');
  const [momoRef, setMomoRef] = useState<string>('');
  const [bankAmount, setBankAmount] = useState<string>('');
  const [bankRef, setBankRef] = useState<string>('');
  // Over-limit PIN gate. When non-null, the modal is open and the
  // callback is what we run on supervisor approval (it threads the
  // returned approvalId into createSale).
  const [pinPrompt, setPinPrompt] = useState<{
    reason: string;
    context: Record<string, unknown>;
    onApproved: (approvalId: string) => Promise<void>;
  } | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Shop header for receipt printing. Loaded once on mount and used
  // by printReceipt after a successful sale. Defaults sensibly so a
  // failed deviceConfig fetch doesn't block receipts.
  const [shop, setShop] = useState<ReceiptShop>({
    shopName: 'Counter', shopSubtitle: '', ownerPhone: null,
  });
  // Cashier name for the receipt header. Pulled from session via
  // primitive selector (Section 1 CLAUDE.md — never an object literal).
  const cashierName = useSession((st) => st.fullName) ?? '';
  // When non-null, the PrintableReceipt component renders + triggers
  // window.print() once, then calls onDone which resets the screen
  // for the next customer (cart cleared, focus back on search) —
  // POS-style "stay on the till" flow rather than navigating away.
  const [pendingPrint, setPendingPrint] = useState<ReceiptData | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Last completed sale's headline (total + change + credit), shown
  // briefly as a confirmation banner so the cashier sees what just
  // happened before the next sale starts. Cleared on the next
  // submit or after a few seconds.
  const [lastCompleted, setLastCompleted] = useState<{
    totalPesewas: number;
    changePesewas: number;
    creditPesewas: number;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const r = await counter.listProducts();
      if (r.success) setProducts(r.data.products);
      const c = await counter.listCustomers({});
      if (c.success) setCustomers(c.data.customers);
      const d = await counter.deviceConfig();
      if (d.success) {
        setShop({
          shopName: d.data.shopName,
          shopSubtitle: d.data.shopSubtitle,
          ownerPhone: d.data.ownerPhone,
        });
      }
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

  // Split the search string into filter text + pending qty multiplier.
  // Recomputed on every keystroke; cheap.
  const parsed = useMemo(() => parseSearchWithMultiplier(search), [search]);

  const filtered = useMemo(() => {
    const q = parsed.text.toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q),
    );
  }, [parsed.text, products]);

  function addToCart(p: ProductSummary, qty: number = 1) {
    if (qty <= 0) return;
    setCart((prev) => {
      const existing = prev.find((l) => l.productId === p.id);
      if (existing) {
        return prev.map((l) =>
          l.productId === p.id ? { ...l, quantity: l.quantity + qty } : l,
        );
      }
      return [
        ...prev,
        {
          productId: p.id,
          productName: p.name,
          quantity: qty,
          unitPricePesewas: priceFor(p, channel),
          unitCostPesewas: p.costPricePesewas,
        },
      ];
    });
  }

  // Clear all per-sale state and refocus the product search so the
  // cashier can immediately start ringing the next customer. Channel
  // is preserved deliberately — cashiers typically ring runs of
  // same-channel sales (a wholesale block, then a route block).
  function resetForNextSale() {
    setCart([]);
    setCustomerId('');
    setCustomerCredit(null);
    setCashGiven('');
    setMomoAmount('');
    setMomoRef('');
    setBankAmount('');
    setBankRef('');
    setSearch('');
    setError(null);
    setPinPrompt(null);
    // Refocus the search input on the next tick so it lands after
    // the printable receipt component has fully unmounted.
    window.setTimeout(() => searchInputRef.current?.focus(), 50);
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

  // Parsed cedi-string → pesewas. Returns 0 for empty/invalid input
  // rather than throwing — the cashier shouldn't have to enter
  // amounts perfectly for the live summary to render. The final
  // submit path re-parses with strict error handling.
  function safeParse(cedis: string): number {
    if (!cedis.trim()) return 0;
    try { return parseCedisToPesewas(cedis); } catch { return 0; }
  }
  const cashGivenPesewas = safeParse(cashGiven);
  const momoPesewas      = safeParse(momoAmount);
  const bankPesewas      = safeParse(bankAmount);
  const handedOver       = cashGivenPesewas + momoPesewas + bankPesewas;
  const creditOwed       = Math.max(0, total - handedOver);
  const change           = Math.max(0, handedOver - total);

  // Pre-fetch customer credit info when the selection changes so the
  // over-limit gate has fresh numbers without an extra trip on
  // Complete sale.
  useEffect(() => {
    if (!customerId) { setCustomerCredit(null); return; }
    let cancelled = false;
    (async () => {
      const r = await counter.getCustomer({ customerId });
      if (cancelled) return;
      if (r.success) {
        setCustomerCredit({
          creditLimitPesewas: r.data.customer.creditLimitPesewas,
          currentBalancePesewas: r.data.customer.currentBalancePesewas,
        });
      } else {
        setCustomerCredit(null);
      }
    })();
    return () => { cancelled = true; };
  }, [customerId]);

  // Build the multi-tender array from the current input state. Only
  // emits a row per method with non-zero amount. Cash row carries the
  // cashGiven figure so the service can compute change.
  function buildTenders(): PaymentTenderInput[] {
    const tenders: PaymentTenderInput[] = [];
    // cashApplied = the portion of the cash given that actually pays
    // the sale (the rest is change). If only cash is being used and
    // it exceeds the total, the excess is change; cashApplied caps at
    // (total − momo − bank).
    const restAfterNonCash = Math.max(0, total - momoPesewas - bankPesewas);
    const cashApplied = Math.min(cashGivenPesewas, restAfterNonCash);
    if (cashApplied > 0) {
      tenders.push({
        method: 'CASH',
        amountPesewas: cashApplied,
        cashGivenPesewas: cashGivenPesewas,  // ≥ cashApplied
      });
    }
    if (momoPesewas > 0) {
      tenders.push({
        method: 'MOMO',
        amountPesewas: momoPesewas,
        ...(momoRef.trim() ? { paymentReference: momoRef.trim() } : {}),
      });
    }
    if (bankPesewas > 0) {
      tenders.push({
        method: 'BANK',
        amountPesewas: bankPesewas,
        ...(bankRef.trim() ? { paymentReference: bankRef.trim() } : {}),
      });
    }
    if (creditOwed > 0) {
      tenders.push({ method: 'CREDIT', amountPesewas: creditOwed });
    }
    return tenders;
  }

  // The actual sale-creation call. Threads supervisorApprovalId in
  // when over-limit; otherwise omitted.
  async function completeCore(supervisorApprovalId?: string) {
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
      payments: buildTenders(),
      supervisorApprovalId,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }

    // Set the pending-print data. The PrintableReceipt component
    // mounts (in a portal to document.body), triggers window.print()
    // — which is synchronous-blocking until the user dismisses the
    // OS dialog — then calls onDone() which navigates away. No
    // confirmation alert: the printed receipt IS the confirmation.
    const customer = customerId ? customers.find((c) => c.id === customerId) : null;
    setPendingPrint({
      saleId: r.data.saleId,
      createdAtISO: new Date().toISOString(),
      cashierName: cashierName || '—',
      customerName: customer?.displayName ?? null,
      channel,
      lines: cart.map((l) => ({
        productName: l.productName,
        quantity: l.quantity,
        unitPricePesewas: l.unitPricePesewas,
      })),
      totalPesewas: r.data.totalPesewas,
      cashPaidPesewas: r.data.cashPaidPesewas,
      momoPaidPesewas: r.data.momoPaidPesewas,
      bankPaidPesewas: r.data.bankPaidPesewas,
      creditPesewas: r.data.creditPesewas,
      changePesewas: r.data.changePesewas,
    });
    setLastCompleted({
      totalPesewas: r.data.totalPesewas,
      changePesewas: r.data.changePesewas,
      creditPesewas: r.data.creditPesewas,
    });
  }

  async function complete() {
    setError(null);
    if (cart.length === 0) {
      setError('Add at least one product before completing the sale.');
      return;
    }
    if (creditOwed > 0 && !customerId) {
      setError('A customer is required when any amount is on credit.');
      return;
    }

    // Over-credit-limit gate. We compare the projected balance after
    // this sale's CREDIT portion against the customer's limit. The
    // service runs the same check authoritatively; this client-side
    // pre-check avoids round-tripping for the modal prompt.
    if (creditOwed > 0 && customerCredit) {
      const projected = customerCredit.currentBalancePesewas + creditOwed;
      if (projected > customerCredit.creditLimitPesewas) {
        const cust = customers.find((c) => c.id === customerId);
        const name = cust?.displayName ?? 'this customer';
        setPinPrompt({
          reason: `This sale would put ${name} at ₵${formatMoney(projected)} owed, above the ₵${formatMoney(customerCredit.creditLimitPesewas)} credit limit. A supervisor must approve.`,
          context: {
            customerId,
            creditOwedPesewas: creditOwed,
            projectedBalancePesewas: projected,
            creditLimitPesewas: customerCredit.creditLimitPesewas,
          },
          onApproved: async (approvalId) => {
            setPinPrompt(null);
            await completeCore(approvalId);
          },
        });
        return;
      }
    }

    await completeCore();
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
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // Enter adds the top filtered product with the parsed
                // multiplier; clears the box so the next product can
                // be searched immediately.
                if (e.key === 'Enter' && filtered.length > 0) {
                  addToCart(filtered[0], parsed.qty);
                  setSearch('');
                  e.preventDefault();
                }
              }}
              autoFocus
              placeholder="Search products by name or SKU…  (suffix *24 to add 24)"
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
            />
            {parsed.qty > 1 && (
              <div className="mt-1 text-xs text-accent">
                Next add: <span className="font-mono tnum">{parsed.qty}</span> units
                <span className="text-text-tertiary"> — press Enter or click a product</span>
              </div>
            )}
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
                      onClick={() => addToCart(p, parsed.qty)}
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
                        <QtyCell
                          value={l.quantity}
                          onChange={(n) => setQty(l.productId, n)}
                        />
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
            {lastCompleted && cart.length === 0 && (
              <div className="border border-success bg-success/10 text-success px-3 py-2 text-xs rounded">
                <div className="font-semibold">Last sale complete · ₵{formatMoney(lastCompleted.totalPesewas)}</div>
                {lastCompleted.changePesewas > 0 && (
                  <div>Change due: ₵{formatMoney(lastCompleted.changePesewas)}</div>
                )}
                {lastCompleted.creditPesewas > 0 && (
                  <div>On credit: ₵{formatMoney(lastCompleted.creditPesewas)}</div>
                )}
              </div>
            )}
            <div className="flex items-baseline justify-between">
              <div className="text-text-secondary uppercase text-xs tracking-wider">Total</div>
              <div className="font-mono tnum text-2xl">{formatMoneyWithCurrency(total)}</div>
            </div>

            {customerCredit && customerId && (
              <div className="text-xs text-text-tertiary border border-border px-2 py-1 font-mono tnum">
                Limit ₵{formatMoney(customerCredit.creditLimitPesewas)} · owed ₵{formatMoney(customerCredit.currentBalancePesewas)}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-xs text-text-secondary uppercase tracking-wider">Tendered</div>
              <TenderRow
                label="Cash given"
                amount={cashGiven}
                onAmount={setCashGiven}
                placeholder="0.00"
                rightHint={total > 0 ? `total ₵${formatMoney(total)}` : undefined}
                onFill={total > 0 ? () => {
                  // Snap cash given to whatever's left after MoMo/Bank.
                  const rest = Math.max(0, total - momoPesewas - bankPesewas);
                  setCashGiven((rest / 100).toFixed(2));
                } : undefined}
              />
              <TenderRow
                label="MoMo"
                amount={momoAmount}
                onAmount={setMomoAmount}
                reference={momoRef}
                onReference={setMomoRef}
              />
              <TenderRow
                label="Bank"
                amount={bankAmount}
                onAmount={setBankAmount}
                reference={bankRef}
                onReference={setBankRef}
              />
            </div>

            {total > 0 && (
              <div className="border-t border-border pt-3 space-y-1 text-sm font-mono tnum">
                <div className="flex justify-between">
                  <span className="text-text-secondary">Handed over</span>
                  <span>₵{formatMoney(handedOver)}</span>
                </div>
                {change > 0 && (
                  <div className="flex justify-between text-success">
                    <span>Change due</span>
                    <span>₵{formatMoney(change)}</span>
                  </div>
                )}
                {creditOwed > 0 && (
                  <div className="flex justify-between text-warning">
                    <span>On credit</span>
                    <span>₵{formatMoney(creditOwed)}</span>
                  </div>
                )}
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

      {pinPrompt && (
        <SupervisorPinModal
          purpose="OVER_LIMIT_PARTIAL"
          reason={pinPrompt.reason}
          context={pinPrompt.context}
          onClose={() => setPinPrompt(null)}
          onApproved={(resp) => { void pinPrompt.onApproved(resp.approvalId); }}
        />
      )}

      {pendingPrint && (
        <PrintableReceipt
          shop={shop}
          data={pendingPrint}
          onDone={() => {
            setPendingPrint(null);
            resetForNextSale();
            // Auto-dismiss the confirmation banner after a few
            // seconds so the screen returns to its neutral state if
            // the cashier doesn't immediately ring the next sale.
            window.setTimeout(() => setLastCompleted(null), 6000);
          }}
        />
      )}
    </div>
  );
}

// TenderRow — one line of the multi-tender entry section. Amount is
// always required; reference + fill button are opt-in via the
// corresponding props. Stays a stateless leaf component so the
// SaleScreen owns all tender state in one place.
function TenderRow({
  label, amount, onAmount, placeholder = '0.00',
  reference, onReference,
  rightHint, onFill,
}: {
  label: string;
  amount: string;
  onAmount: (v: string) => void;
  placeholder?: string;
  reference?: string;
  onReference?: (v: string) => void;
  rightHint?: string;
  onFill?: () => void;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <label className="text-xs text-text-secondary w-20 shrink-0">{label}</label>
      <span className="text-text-tertiary text-xs">₵</span>
      <input
        value={amount}
        onChange={(e) => onAmount(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        className="w-24 bg-bg-deep border border-border px-2 py-1 text-sm font-mono tnum"
      />
      {onReference && (
        <input
          value={reference ?? ''}
          onChange={(e) => onReference(e.target.value)}
          placeholder="ref"
          className="flex-1 bg-bg-deep border border-border px-2 py-1 text-xs"
        />
      )}
      {rightHint && (
        <span className="text-text-tertiary text-xs flex-1">{rightHint}</span>
      )}
      {onFill && (
        <button
          onClick={onFill}
          className="text-xs text-accent hover:underline"
          type="button"
        >fill</button>
      )}
    </div>
  );
}
