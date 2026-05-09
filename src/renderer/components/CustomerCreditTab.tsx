// CustomerCreditTab — open credit sales + payment history. The
// "Record payment" button opens RecordPaymentModal. Used as a tab on
// CustomerDetailScreen.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney } from '../../shared/lib/money';
import RecordPaymentModal from './RecordPaymentModal';
import SaleDetailModal from './SaleDetailModal';

interface Props {
  customerId: string;
  customerName: string;
  currentBalancePesewas: number;
  onChanged: () => void;             // tells parent to refresh customer
}

export default function CustomerCreditTab({
  customerId, customerName, currentBalancePesewas, onChanged,
}: Props): JSX.Element {
  const [openSales, setOpenSales] = useState<Array<{
    saleId: string; createdAt: string; totalPesewas: number;
    paidPesewas: number; openBalancePesewas: number;
    paymentMethodOriginal: string;
  }>>([]);
  const [payments, setPayments] = useState<Array<{
    paymentId: string; createdAt: string; amountPesewas: number;
    paymentMethod: string; paymentReference: string | null;
    notes: string | null; workerName: string;
    allocationCount: number; unallocatedPesewas: number;
  }>>([]);
  const [showRecord, setShowRecord] = useState(false);
  const [openSaleDetailId, setOpenSaleDetailId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const a = await counter.openCreditSales({ customerId });
    const b = await counter.listPayments({ customerId, limit: 30 });
    if (!a.success) { setError(a.error); return; }
    if (!b.success) { setError(b.error); return; }
    setOpenSales(a.data.sales);
    setPayments(b.data.payments);
  }
  useEffect(() => { void refresh(); }, [customerId]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}

      <div className="bg-bg-surface border border-border p-4">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-xs text-text-secondary uppercase tracking-wider">Open balance</div>
            <div className={[
              'font-mono tnum text-2xl mt-1',
              currentBalancePesewas > 0 ? 'text-warning'
              : currentBalancePesewas < 0 ? 'text-success' : '',
            ].join(' ')}>
              ₵{formatMoney(currentBalancePesewas)}
              {currentBalancePesewas < 0 && (
                <span className="ml-2 text-xs text-text-tertiary normal-case">(store credit — shop owes)</span>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowRecord(true)}
            className="text-sm px-3 py-2 bg-accent text-bg-deep font-semibold"
          >
            Record payment
          </button>
        </div>
      </div>

      <div>
        <div className="text-text-secondary uppercase tracking-wider text-xs mb-2">
          Open credit sales
        </div>
        <div className="bg-bg-surface border border-border">
          {openSales.length === 0 ? (
            <div className="px-4 py-6 text-text-tertiary text-sm text-center">
              No unpaid credit sales.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-secondary uppercase tracking-wider text-xs">
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-right">Sale total</th>
                  <th className="px-4 py-2 text-right">Paid</th>
                  <th className="px-4 py-2 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {openSales.map((s) => (
                  <tr key={s.saleId}
                      onClick={() => setOpenSaleDetailId(s.saleId)}
                      className="border-t border-border cursor-pointer hover:bg-bg-elevated">
                    <td className="px-4 py-2 text-text-tertiary">
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tnum">₵{formatMoney(s.totalPesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum text-text-tertiary">₵{formatMoney(s.paidPesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum text-warning">₵{formatMoney(s.openBalancePesewas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div>
        <div className="text-text-secondary uppercase tracking-wider text-xs mb-2">
          Payment history
        </div>
        <div className="bg-bg-surface border border-border">
          {payments.length === 0 ? (
            <div className="px-4 py-6 text-text-tertiary text-sm text-center">
              No payments recorded yet.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-secondary uppercase tracking-wider text-xs">
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Method</th>
                  <th className="px-4 py-2 text-left">Reference</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.paymentId} className="border-t border-border">
                    <td className="px-4 py-2 text-text-tertiary">
                      {new Date(p.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2">{p.paymentMethod}</td>
                    <td className="px-4 py-2 text-text-tertiary font-mono tnum text-xs">
                      {p.paymentReference ?? <span className="opacity-50">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tnum text-success">
                      ₵{formatMoney(p.amountPesewas)}
                      {p.unallocatedPesewas > 0 && (
                        <div className="text-xs text-text-tertiary normal-case">
                          ₵{formatMoney(p.unallocatedPesewas)} unallocated
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showRecord && (
        <RecordPaymentModal
          customerId={customerId}
          customerName={customerName}
          currentBalancePesewas={currentBalancePesewas}
          onClose={() => setShowRecord(false)}
          onRecorded={() => {
            setShowRecord(false);
            void refresh();
            onChanged();
          }}
        />
      )}

      {openSaleDetailId && (
        <SaleDetailModal
          saleId={openSaleDetailId}
          onClose={() => setOpenSaleDetailId(null)}
          onChanged={() => { void refresh(); onChanged(); }}
        />
      )}
    </div>
  );
}
