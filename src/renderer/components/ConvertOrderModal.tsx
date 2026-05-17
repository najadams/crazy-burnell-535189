// ConvertOrderModal — turn a pending order into a sale.
//
// The depot lead opens this after the driver returns from delivery
// with whatever the customer paid. Lines are fixed (read from the
// pending order); the form is multi-tender entry — cash given, MoMo,
// bank — and the remainder goes on credit. Over-limit prompts the
// SupervisorPinModal (purpose OVER_LIMIT_PARTIAL) and threads the
// returned approval id into pendingOrderConvert, which in turn passes
// it to createSale.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import SupervisorPinModal from './SupervisorPinModal';
import type {
  PendingOrderRowDto, PendingOrderLineRowDto, PaymentTenderInput,
} from '../../shared/types/ipc';

interface Props {
  pendingOrderId: string;
  onClose: () => void;
  onConverted: (saleId: string) => void;
}

interface CreditContext {
  creditLimitPesewas: number;
  currentBalancePesewas: number;
}

export default function ConvertOrderModal({
  pendingOrderId, onClose, onConverted,
}: Props): JSX.Element {
  const [order, setOrder] = useState<PendingOrderRowDto | null>(null);
  const [lines, setLines] = useState<PendingOrderLineRowDto[]>([]);
  const [credit, setCredit] = useState<CreditContext | null>(null);
  const [channel, setChannel] = useState<'WALK_IN' | 'WHOLESALE' | 'ROUTE'>('ROUTE');
  const [cashGiven, setCashGiven] = useState('');
  const [momoAmount, setMomoAmount] = useState('');
  const [momoRef, setMomoRef] = useState('');
  const [bankAmount, setBankAmount] = useState('');
  const [bankRef, setBankRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinPrompt, setPinPrompt] = useState<{
    reason: string;
    context: Record<string, unknown>;
    onApproved: (approvalId: string) => Promise<void>;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const r = await counter.pendingOrderGet({ pendingOrderId });
      if (!r.success) { setError(r.error); return; }
      setOrder(r.data.order);
      setLines(r.data.lines);
      // Pre-fetch the customer's credit context for the over-limit
      // pre-check (saves a round trip when the cashier hits Convert).
      const c = await counter.getCustomer({ customerId: r.data.order.customerId });
      if (c.success) {
        setCredit({
          creditLimitPesewas: c.data.customer.creditLimitPesewas,
          currentBalancePesewas: c.data.customer.currentBalancePesewas,
        });
      }
    })();
  }, [pendingOrderId]);

  function safeParse(v: string): number {
    if (!v.trim()) return 0;
    try { return parseCedisToPesewas(v); } catch { return 0; }
  }
  const total = lines.reduce((s, l) => s + l.lineTotalPesewasAtIntake, 0);
  const cashGivenPesewas = safeParse(cashGiven);
  const momoPesewas = safeParse(momoAmount);
  const bankPesewas = safeParse(bankAmount);
  const handedOver = cashGivenPesewas + momoPesewas + bankPesewas;
  const creditOwed = Math.max(0, total - handedOver);
  const change = Math.max(0, handedOver - total);

  function buildTenders(): PaymentTenderInput[] {
    const tenders: PaymentTenderInput[] = [];
    const restAfterNonCash = Math.max(0, total - momoPesewas - bankPesewas);
    const cashApplied = Math.min(cashGivenPesewas, restAfterNonCash);
    if (cashApplied > 0) {
      tenders.push({ method: 'CASH', amountPesewas: cashApplied, cashGivenPesewas });
    }
    if (momoPesewas > 0) {
      tenders.push({
        method: 'MOMO', amountPesewas: momoPesewas,
        ...(momoRef.trim() ? { paymentReference: momoRef.trim() } : {}),
      });
    }
    if (bankPesewas > 0) {
      tenders.push({
        method: 'BANK', amountPesewas: bankPesewas,
        ...(bankRef.trim() ? { paymentReference: bankRef.trim() } : {}),
      });
    }
    if (creditOwed > 0) tenders.push({ method: 'CREDIT', amountPesewas: creditOwed });
    return tenders;
  }

  async function convertCore(supervisorApprovalId?: string) {
    setBusy(true);
    const r = await counter.pendingOrderConvert({
      pendingOrderId,
      channel,
      payments: buildTenders(),
      supervisorApprovalId,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    onConverted(r.data.saleId);
  }

  async function submit() {
    setError(null);
    if (!order) return;
    if (total <= 0) { setError('Order total is zero.'); return; }
    if (creditOwed > 0 && credit) {
      const projected = credit.currentBalancePesewas + creditOwed;
      if (projected > credit.creditLimitPesewas) {
        setPinPrompt({
          reason: `This conversion would put ${order.customerName ?? 'the customer'} at ₵${formatMoney(projected)} owed, above the ₵${formatMoney(credit.creditLimitPesewas)} credit limit. A supervisor must approve.`,
          context: {
            pendingOrderId,
            customerId: order.customerId,
            creditOwedPesewas: creditOwed,
            projectedBalancePesewas: projected,
            creditLimitPesewas: credit.creditLimitPesewas,
          },
          onApproved: async (approvalId) => {
            setPinPrompt(null);
            await convertCore(approvalId);
          },
        });
        return;
      }
    }
    await convertCore();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">Convert order to sale</div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
              {error}
            </div>
          )}

          {order && (
            <div className="text-sm space-y-1">
              <div>
                <span className="text-text-tertiary">Customer:</span>{' '}
                <span className="font-semibold">{order.customerName}</span>
              </div>
              <div className="text-xs text-text-tertiary">
                Intake: {order.intakeChannel.replace('_', ' ').toLowerCase()} ·
                by {order.intakeWorkerName ?? order.intakeWorkerId} ·
                {new Date(order.createdAt).toLocaleString()}
              </div>
              {credit && (
                <div className="text-xs text-text-tertiary">
                  Credit limit ₵{formatMoney(credit.creditLimitPesewas)} ·
                  currently owed ₵{formatMoney(credit.currentBalancePesewas)}
                </div>
              )}
            </div>
          )}

          <div className="border border-border rounded">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-tertiary text-xs uppercase tracking-wider">
                  <th className="text-left px-3 py-2">Item</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-right px-3 py-2">Unit</th>
                  <th className="text-right px-3 py-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="px-3 py-1.5">{l.productName}</td>
                    <td className="px-3 py-1.5 text-right font-mono tnum">{l.quantity}</td>
                    <td className="px-3 py-1.5 text-right font-mono tnum">₵{formatMoney(l.unitPricePesewasAtIntake)}</td>
                    <td className="px-3 py-1.5 text-right font-mono tnum">₵{formatMoney(l.lineTotalPesewasAtIntake)}</td>
                  </tr>
                ))}
                <tr className="border-t border-border bg-bg-elevated">
                  <td colSpan={3} className="px-3 py-2 text-right text-xs uppercase tracking-wider text-text-secondary">Total</td>
                  <td className="px-3 py-2 text-right font-mono tnum text-base">₵{formatMoney(total)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Channel</div>
            <div className="flex gap-1">
              {(['WALK_IN','WHOLESALE','ROUTE'] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setChannel(c)}
                  className={[
                    'px-3 py-1 text-xs border',
                    channel === c ? 'bg-accent text-bg-deep border-accent' : 'border-border hover:bg-bg-elevated',
                  ].join(' ')}
                >{c.replace('_', ' ')}</button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs text-text-secondary uppercase tracking-wider">Tendered</div>
            <TenderRow label="Cash given" amount={cashGiven} onAmount={setCashGiven} />
            <TenderRow label="MoMo" amount={momoAmount} onAmount={setMomoAmount} reference={momoRef} onReference={setMomoRef} />
            <TenderRow label="Bank" amount={bankAmount} onAmount={setBankAmount} reference={bankRef} onReference={setBankRef} />
          </div>

          <div className="border-t border-border pt-3 space-y-1 text-sm font-mono tnum">
            <div className="flex justify-between">
              <span className="text-text-secondary">Handed over</span>
              <span>₵{formatMoney(handedOver)}</span>
            </div>
            {change > 0 && (
              <div className="flex justify-between text-success">
                <span>Change due</span><span>₵{formatMoney(change)}</span>
              </div>
            )}
            {creditOwed > 0 && (
              <div className="flex justify-between text-warning">
                <span>On credit</span><span>₵{formatMoney(creditOwed)}</span>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} disabled={busy}
              className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated disabled:opacity-50"
            >Cancel</button>
            <button
              onClick={() => void submit()}
              disabled={busy || total <= 0}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50"
            >
              {busy ? 'Converting…' : 'Convert to sale'}
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
    </div>
  );
}

function TenderRow({
  label, amount, onAmount, reference, onReference,
}: {
  label: string;
  amount: string;
  onAmount: (v: string) => void;
  reference?: string;
  onReference?: (v: string) => void;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <label className="text-xs text-text-secondary w-20 shrink-0">{label}</label>
      <span className="text-text-tertiary text-xs">₵</span>
      <input
        value={amount}
        onChange={(e) => onAmount(e.target.value)}
        placeholder="0.00"
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
    </div>
  );
}
