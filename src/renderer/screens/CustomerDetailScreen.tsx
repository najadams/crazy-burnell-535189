// CustomerDetailScreen — three tabs: profile, history, performance.
// Performance is the Wave H scorecard.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import CustomerPerformanceTab from '../components/CustomerPerformanceTab';
import CustomerCreditTab from '../components/CustomerCreditTab';
import { formatMoney } from '../../shared/lib/money';
import { formatGhanaPhone } from '../../shared/lib/phone';
import type { CustomerSummary } from '../../shared/types/ipc';

interface Props {
  customerId: string;
  onBack: () => void;
}

type Tab = 'profile' | 'credit' | 'history' | 'performance';

export default function CustomerDetailScreen({ customerId, onBack }: Props): JSX.Element {
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('profile');
  const [history, setHistory] = useState<Array<{
    id: string;
    createdAt: string;
    totalPesewas: number;
    voided: boolean;
    paymentMethod: string;
    lineCount: number;
  }>>([]);

  useEffect(() => {
    (async () => {
      const r = await counter.getCustomer({ customerId });
      if (!r.success) { setError(r.error); return; }
      setCustomer(r.data.customer);
    })();
  }, [customerId]);

  useEffect(() => {
    if (tab !== 'history') return;
    (async () => {
      const r = await counter.recentSalesForCustomer({ customerId, limit: 30 });
      if (r.success) setHistory(r.data.sales);
    })();
  }, [tab, customerId]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="flex items-baseline justify-between px-6 py-4 border-b border-border bg-bg-surface">
        <div className="flex items-baseline gap-4">
          <button onClick={onBack} className="text-text-tertiary hover:text-text-primary text-sm">
            ← Customers
          </button>
          <div className="text-xl font-semibold tracking-tight">
            {customer?.displayName ?? '…'}
          </div>
          {customer && (
            <div className="text-text-tertiary text-sm">
              {formatGhanaPhone(customer.phone)} · {customer.customerType}
            </div>
          )}
        </div>
      </header>

      {/* Tabs */}
      <div className="px-6 pt-3 border-b border-border bg-bg-surface flex gap-1">
        <TabBtn active={tab === 'profile'}     onClick={() => setTab('profile')}>Profile</TabBtn>
        <TabBtn active={tab === 'credit'}      onClick={() => setTab('credit')}>Credit</TabBtn>
        <TabBtn active={tab === 'history'}     onClick={() => setTab('history')}>History</TabBtn>
        <TabBtn active={tab === 'performance'} onClick={() => setTab('performance')}>Performance</TabBtn>
      </div>

      {error && (
        <div className="m-4 border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-6">
        {tab === 'profile' && customer && (
          <div className="bg-bg-surface border border-border p-4 max-w-md space-y-2 text-sm">
            <Row k="Name"        v={customer.displayName} />
            <Row k="Phone"       v={formatGhanaPhone(customer.phone)} mono />
            <Row k="Type"        v={customer.customerType} />
            <Row k="Balance"     v={`₵${formatMoney(customer.currentBalancePesewas)}`} mono
                  warn={customer.currentBalancePesewas > 0} />
            <Row k="Status"      v={customer.blocked ? 'Blocked' : 'Active'}
                  warn={customer.blocked} />
          </div>
        )}

        {tab === 'credit' && customer && (
          <CustomerCreditTab
            customerId={customer.id}
            customerName={customer.displayName}
            currentBalancePesewas={customer.currentBalancePesewas}
            onChanged={async () => {
              const r = await counter.getCustomer({ customerId });
              if (r.success) setCustomer(r.data.customer);
            }}
          />
        )}

        {tab === 'history' && (
          history.length === 0 ? (
            <div className="text-text-tertiary text-sm">No sales recorded.</div>
          ) : (
            <table className="w-full text-sm bg-bg-surface border border-border">
              <thead>
                <tr className="text-text-secondary uppercase tracking-wider text-xs">
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Payment</th>
                  <th className="px-4 py-2 text-right">Lines</th>
                  <th className="px-4 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="px-4 py-2 text-text-tertiary">
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2">{s.paymentMethod}</td>
                    <td className="px-4 py-2 text-right font-mono tnum text-text-tertiary">
                      {s.lineCount}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tnum">
                      {s.voided ? <span className="text-danger">VOID</span> : `₵${formatMoney(s.totalPesewas)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === 'performance' && customer && (
          <CustomerPerformanceTab customerId={customer.id} />
        )}
      </div>
    </div>
  );
}

function TabBtn({
  active, onClick, children,
}: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={[
        'px-4 py-2 text-sm border-b-2 -mb-px',
        active ? 'border-accent text-accent' : 'border-transparent text-text-tertiary hover:text-text-primary',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function Row({ k, v, mono = false, warn = false }: {
  k: string; v: React.ReactNode; mono?: boolean; warn?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-text-tertiary text-xs uppercase tracking-wider">{k}</span>
      <span className={[
        mono ? 'font-mono tnum' : '',
        warn ? 'text-warning' : 'text-text-primary',
      ].join(' ')}>{v}</span>
    </div>
  );
}
