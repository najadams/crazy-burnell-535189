// CustomersScreen — list of customers with a leaderboard view toggle
// (Section 20.7 of CLAUDE.md).

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import CustomerLeaderboardView from '../components/CustomerLeaderboardView';
import { formatMoney } from '../../shared/lib/money';
import { formatGhanaPhone } from '../../shared/lib/phone';
import type { CustomerSummary } from '../../shared/types/ipc';

interface Props {
  onBack: () => void;
  onOpenCustomer: (id: string) => void;
}

type View = 'all' | 'top';

export default function CustomersScreen({ onBack, onOpenCustomer }: Props): JSX.Element {
  const [view, setView] = useState<View>('all');
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (view !== 'all') return;
    (async () => {
      const r = await counter.listCustomers({});
      if (!r.success) { setError(r.error); return; }
      setCustomers(r.data.customers);
    })();
  }, [view]);

  const filtered = customers.filter((c) =>
    !search.trim() ||
    c.displayName.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search),
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="flex items-baseline justify-between px-6 py-4 border-b border-border bg-bg-surface">
        <div className="flex items-baseline gap-4">
          <button
            onClick={onBack}
            className="text-text-tertiary hover:text-text-primary text-sm"
          >
            ← Home
          </button>
          <div className="text-xl font-semibold tracking-tight">Customers</div>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setView('all')}
            className={[
              'text-xs px-3 py-1 border',
              view === 'all'
                ? 'bg-accent text-bg-deep border-accent'
                : 'border-border hover:bg-bg-elevated',
            ].join(' ')}
          >
            All customers
          </button>
          <button
            onClick={() => setView('top')}
            className={[
              'text-xs px-3 py-1 border',
              view === 'top'
                ? 'bg-accent text-bg-deep border-accent'
                : 'border-border hover:bg-bg-elevated',
            ].join(' ')}
          >
            Top customers
          </button>
        </div>
      </header>

      {error && (
        <div className="m-4 border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}

      {view === 'top' ? (
        <div className="flex-1 overflow-auto p-4">
          <CustomerLeaderboardView onSelectCustomer={onOpenCustomer} />
        </div>
      ) : (
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-border bg-bg-surface">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or phone…"
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
            />
          </div>
          <div className="flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <div className="p-4 text-text-tertiary text-sm">No customers.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-secondary uppercase tracking-wider text-xs">
                    <th className="px-4 py-2 text-left">Name</th>
                    <th className="px-4 py-2 text-left">Phone</th>
                    <th className="px-4 py-2 text-left">Type</th>
                    <th className="px-4 py-2 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => onOpenCustomer(c.id)}
                      className="border-t border-border cursor-pointer hover:bg-bg-elevated"
                    >
                      <td className="px-4 py-2">
                        {c.displayName}
                        {c.blocked && <span className="ml-2 text-xs text-danger">(blocked)</span>}
                      </td>
                      <td className="px-4 py-2 font-mono tnum text-text-tertiary">
                        {formatGhanaPhone(c.phone)}
                      </td>
                      <td className="px-4 py-2 text-text-tertiary">{c.customerType}</td>
                      <td className="px-4 py-2 text-right font-mono tnum">
                        {c.currentBalancePesewas > 0
                          ? <span className="text-warning">₵{formatMoney(c.currentBalancePesewas)}</span>
                          : <span className="text-text-tertiary">₵{formatMoney(c.currentBalancePesewas)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
