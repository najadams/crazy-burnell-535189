// SaleDetailModal — show a sale's lines + totals; offer Print Receipt
// and Void Sale (OWNER-gated) actions.
//
// Print uses window.print() with the print stylesheet defined in
// styles/index.css. Anything outside the .receipt-printable wrapper is
// hidden by @media print rules, so the on-screen modal becomes a
// clean printable receipt without a separate window.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoney } from '../../shared/lib/money';
import { formatGhanaPhone } from '../../shared/lib/phone';
import VoidSaleModal from './VoidSaleModal';
import PrintableReceipt from './PrintableReceipt';
import type { SaleGetByIdResponse } from '../../shared/types/ipc';
import type { ReceiptData, ReceiptShop } from '../lib/printing';

interface Props {
  saleId: string;
  onClose: () => void;
  onChanged?: () => void;        // called after a successful void
}

export default function SaleDetailModal({ saleId, onClose, onChanged }: Props): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';

  const [data, setData] = useState<SaleGetByIdResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  // When non-null, PrintableReceipt mounts (portalled to document.body)
  // and triggers window.print() once. The old body-class print path
  // never actually worked because @media print's `body > *` rule
  // hides #root, which contains this modal — so the printed page
  // was always blank. PrintableReceipt sidesteps that by mounting
  // outside #root.
  const [printingData, setPrintingData] = useState<ReceiptData | null>(null);

  useEffect(() => {
    (async () => {
      const r = await counter.getSaleById({ saleId });
      if (!r.success) setError(r.error);
      else setData(r.data);
    })();
  }, [saleId]);

  function printReceipt() {
    if (!data) return;
    setPrintingData({
      saleId: data.sale.id,
      createdAtISO: data.sale.createdAt,
      cashierName: data.worker.fullName,
      customerName: data.customer?.displayName ?? null,
      channel: data.sale.channel as 'WALK_IN' | 'WHOLESALE' | 'ROUTE',
      lines: data.lines.map((l) => ({
        productName: l.productName,
        quantity: l.quantity,
        unitPricePesewas: l.unitPricePesewas,
      })),
      totalPesewas: data.sale.totalPesewas,
      cashPaidPesewas: data.paymentBreakdown.cashPaidPesewas,
      momoPaidPesewas: data.paymentBreakdown.momoPaidPesewas,
      bankPaidPesewas: data.paymentBreakdown.bankPaidPesewas,
      creditPesewas:   data.paymentBreakdown.creditPesewas,
      changePesewas:   data.paymentBreakdown.changePesewas,
    });
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50 receipt-modal-root">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-auto">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between no-print">
          <div className="text-lg font-semibold">Sale detail</div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>

        {error && (
          <div className="mx-6 mt-4 border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
            {error}
          </div>
        )}

        {data && (
          <>
            {/* On-screen sale summary. (Note: this div is no longer
                 the print target — PrintableReceipt portalled to
                 document.body handles printing now. The class names
                 below are kept for the on-screen styling only.) */}
            <div className="receipt-printable px-6 py-5 space-y-4">
              <div className="text-center receipt-header">
                <div className="text-lg font-semibold">{data.shopHeader.shopName}</div>
                <div className="text-xs text-text-tertiary">{data.shopHeader.shopSubtitle}</div>
                {data.shopHeader.ownerPhone && (
                  <div className="text-xs text-text-tertiary font-mono tnum">
                    {formatGhanaPhone(data.shopHeader.ownerPhone)}
                  </div>
                )}
              </div>

              <div className="border-t border-b border-border py-2 text-xs flex justify-between">
                <div className="space-y-0.5">
                  <div><span className="text-text-tertiary">Date:</span> {new Date(data.sale.createdAt).toLocaleString()}</div>
                  <div><span className="text-text-tertiary">Worker:</span> {data.worker.fullName}</div>
                  <div><span className="text-text-tertiary">Channel:</span> {data.sale.channel.replace('_', ' ')}</div>
                </div>
                <div className="space-y-0.5 text-right">
                  <div><span className="text-text-tertiary">Sale:</span> <span className="font-mono tnum">{data.sale.id.slice(0, 12)}…</span></div>
                  <div><span className="text-text-tertiary">Payment:</span> {data.sale.paymentMethod}</div>
                  {data.sale.isCredit && <div className="text-warning">CREDIT</div>}
                </div>
              </div>

              {data.customer && (
                <div className="text-xs text-text-tertiary">
                  Customer: <span className="text-text-primary">{data.customer.displayName}</span>
                  {' '}({formatGhanaPhone(data.customer.phone)})
                </div>
              )}

              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-tertiary text-xs uppercase tracking-wider">
                    <th className="text-left py-1">Item</th>
                    <th className="text-right py-1">Qty</th>
                    <th className="text-right py-1">Unit</th>
                    <th className="text-right py-1">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.id} className="border-t border-border">
                      <td className="py-1">
                        {l.productName}
                        {l.kind === 'BONUS' && <span className="ml-2 text-xs text-success">(BONUS)</span>}
                      </td>
                      <td className="py-1 text-right font-mono tnum">{l.quantity}</td>
                      <td className="py-1 text-right font-mono tnum">₵{formatMoney(l.unitPricePesewas)}</td>
                      <td className="py-1 text-right font-mono tnum">₵{formatMoney(l.lineTotalPesewas)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="border-t border-border pt-2 flex items-baseline justify-between text-base">
                <span className="text-text-secondary uppercase text-xs tracking-wider">Total</span>
                <span className="font-mono tnum text-xl">₵{formatMoney(data.sale.totalPesewas)}</span>
              </div>

              {data.sale.voided && (
                <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded receipt-void-banner">
                  VOIDED on {data.sale.voidedAt ? new Date(data.sale.voidedAt).toLocaleString() : '—'}
                  {data.sale.voidReason && <span> — {data.sale.voidReason}</span>}
                </div>
              )}

              <div className="text-center text-xs text-text-tertiary pt-2 receipt-footer">
                Thank you. — Counter
              </div>
            </div>

            <div className="px-6 py-3 border-t border-border flex items-center justify-end gap-2 no-print">
              <button
                onClick={onClose}
                className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated"
              >
                Close
              </button>
              <button
                onClick={printReceipt}
                className="px-3 py-2 border border-accent text-accent hover:bg-accent hover:text-bg-deep text-sm"
              >
                Print receipt
              </button>
              {!data.sale.voided && (
                <button
                  disabled={!isOwner}
                  onClick={() => setVoidOpen(true)}
                  title={!isOwner ? 'OWNER role required to void' : ''}
                  className={[
                    'px-3 py-2 border text-sm',
                    isOwner
                      ? 'border-danger text-danger hover:bg-danger hover:text-bg-deep'
                      : 'border-border text-text-tertiary opacity-60 cursor-not-allowed',
                  ].join(' ')}
                >
                  Void sale
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {voidOpen && data && (
        <VoidSaleModal
          saleId={data.sale.id}
          saleTotalPesewas={data.sale.totalPesewas}
          customerName={data.customer?.displayName ?? null}
          saleCreatedAt={data.sale.createdAt}
          onClose={() => setVoidOpen(false)}
          onVoided={() => {
            setVoidOpen(false);
            onChanged?.();
            onClose();
          }}
        />
      )}

      {printingData && data && (
        <PrintableReceipt
          shop={{
            shopName: data.shopHeader.shopName,
            shopSubtitle: data.shopHeader.shopSubtitle,
            ownerPhone: data.shopHeader.ownerPhone,
          } satisfies ReceiptShop}
          data={printingData}
          reprint
          onDone={() => setPrintingData(null)}
        />
      )}
    </div>
  );
}
