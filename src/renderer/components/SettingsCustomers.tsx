// SettingsCustomers — list current customers and add new ones.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import { normalizeGhanaPhone, formatGhanaPhone } from '../../shared/lib/phone';
import type { CustomerSummary } from '../../shared/types/ipc';

export default function SettingsCustomers(): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [adding, setAdding] = useState(false);

  async function refresh() {
    const r = await counter.listCustomers({});
    if (r.success) setCustomers(r.data.customers);
  }
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-lg font-semibold">Customers</div>
          <div className="text-sm text-text-tertiary mt-1">
            Add retailers, route customers, and walk-ins. The Sale screen lets you
            attach a customer to any sale.
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
          + Add customer
        </button>
      </div>

      {adding && (
        <AddCustomerForm
          onCancel={() => setAdding(false)}
          onAdded={() => { setAdding(false); void refresh(); }}
        />
      )}

      <div className="bg-bg-surface border border-border">
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
            {customers.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="px-4 py-2">
                  {c.displayName}
                  {c.blocked && <span className="ml-2 text-xs text-danger">(blocked)</span>}
                </td>
                <td className="px-4 py-2 font-mono tnum text-text-tertiary">{formatGhanaPhone(c.phone)}</td>
                <td className="px-4 py-2 text-text-tertiary">{c.customerType}</td>
                <td className="px-4 py-2 text-right font-mono tnum">₵{formatMoney(c.currentBalancePesewas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddCustomerForm({ onCancel, onAdded }: {
  onCancel: () => void; onAdded: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<'WALK_IN' | 'WHOLESALE' | 'ROUTE'>('WHOLESALE');
  const [creditLimitCedis, setCreditLimitCedis] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    const normalized = normalizeGhanaPhone(phone);
    if (!normalized) {
      setError('Phone must be a Ghana number (e.g. 0244111222 or +233244111222).');
      return;
    }
    let limit: number;
    try { limit = parseCedisToPesewas(creditLimitCedis || '0'); }
    catch (e: any) { setError(e?.message ?? 'Invalid credit limit.'); return; }

    setBusy(true);
    const r = await counter.createCustomer({
      displayName: name.trim(),
      phone: normalized,
      customerType: type,
      creditLimitPesewas: limit,
      preferredChannel: type,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    onAdded();
  }

  return (
    <div className="bg-bg-surface border border-border p-4 space-y-3">
      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="space-y-1 col-span-2">
          <label className="text-xs text-text-secondary">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
                 className="w-full bg-bg-deep border border-border px-3 py-2 text-sm" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-text-secondary">Phone</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)}
                 placeholder="0244 111 222"
                 className="w-full bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-text-secondary">Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as any)}
                  className="w-full bg-bg-deep border border-border px-3 py-2 text-sm">
            <option value="WALK_IN">Walk-in</option>
            <option value="WHOLESALE">Wholesale</option>
            <option value="ROUTE">Route</option>
          </select>
        </div>
        <div className="space-y-1 col-span-2">
          <label className="text-xs text-text-secondary">Credit limit (cedis, 0 = no credit)</label>
          <input value={creditLimitCedis} onChange={(e) => setCreditLimitCedis(e.target.value)}
                 className="w-full bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum" />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated">
          Cancel
        </button>
        <button onClick={() => void submit()} disabled={busy}
                className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50">
          {busy ? 'Saving…' : 'Add customer'}
        </button>
      </div>
    </div>
  );
}
