// HomeScreen — action grid + clickable recent sales (for void).
//
// Grid:
//   New sale  | Customers
//   Stock     | Cash drop
//   Settings  | Close shift
//
// Clicking a recent sale row opens the VoidSaleModal (OWNER-gated
// inside the modal; non-OWNERs see the disabled state).

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import type { Route } from '../App';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import CashDropModal from '../components/CashDropModal';
import SaleDetailModal from '../components/SaleDetailModal';
import BackupHealthBanner from '../components/BackupHealthBanner';

interface Props { onNavigate: (r: Route) => void }

interface RecentSale {
  id: string; createdAt: string; totalPesewas: number;
  customerName: string | null; voided: boolean;
}

export default function HomeScreen({ onNavigate }: Props): JSX.Element {
  const fullName = useSession((s) => s.fullName);
  const role = useSession((s) => s.workerRole);
  const setSession = useSession((s) => s.setSession);

  const [shopName, setShopName] = useState('Counter');
  const [recent, setRecent] = useState<RecentSale[]>([]);
  const [showCashDrop, setShowCashDrop] = useState(false);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  const [closingError, setClosingError] = useState<string | null>(null);

  async function refreshRecent() {
    const rs = await counter.recentSales({ limit: 8 });
    if (rs.success) setRecent(rs.data.sales);
  }

  useEffect(() => {
    (async () => {
      const dc = await counter.deviceConfig();
      if (dc.success) setShopName(dc.data.shopName);
      await refreshRecent();
    })();
  }, []);

  async function logout() {
    await counter.logout();
    setSession(null);
  }

  async function closeShift() {
    setClosingError(null);
    const txt = window.prompt(
      'Closing cash count (cedis):\n\n' +
      'Counts what\'s in the till right now. The system compares against ' +
      '(opening + cash sales − cash drops) and shows the delta.',
      '0.00',
    );
    if (txt === null) return;
    try {
      const counted = parseCedisToPesewas(txt);
      const r = await counter.closeShift({ countedAmountPesewas: counted });
      if (!r.success) { setClosingError(r.error); return; }
      window.alert(
        `Shift closed.\n\n` +
        `Expected: ₵${formatMoney(r.data.expectedAmountPesewas)}\n` +
        `Counted:  ₵${formatMoney(r.data.countedAmountPesewas)}\n` +
        `Delta:    ${r.data.deltaPesewas >= 0 ? '+' : ''}₵${formatMoney(r.data.deltaPesewas)}\n\n` +
        (r.data.deltaPesewas === 0
          ? 'Till balanced.'
          : (r.data.deltaPesewas > 0
              ? 'Till is over (more cash than expected).'
              : 'Till is short (less cash than expected).')),
      );
      window.location.reload();
    } catch (e: any) {
      setClosingError(e?.message ?? 'Could not parse the cash amount.');
    }
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-baseline justify-between px-6 py-4 border-b border-border bg-bg-surface">
        <div>
          <div className="text-xl font-semibold tracking-tight">{shopName}</div>
          <div className="text-xs text-text-tertiary">{fullName} — {role}</div>
        </div>
        <button onClick={() => void logout()}
                className="text-xs text-text-tertiary hover:text-text-primary underline-offset-2 hover:underline">
          Sign out
        </button>
      </header>

      <div className="flex-1 p-6 max-w-3xl mx-auto w-full content-start">
      <BackupHealthBanner />
      <div className="grid grid-cols-2 gap-4">
        <ActionButton label="New sale"   desc="Ring up a customer"        onClick={() => onNavigate({ name: 'sale' })} accent />
        <ActionButton label="Customers"  desc="Browse, scorecards, leaderboard" onClick={() => onNavigate({ name: 'customers' })} />
        <ActionButton label="Stock"      desc="On hand and receive shipments" onClick={() => onNavigate({ name: 'stock' })} />
        <ActionButton label="Cash drop"  desc="Record cash leaving the till"  onClick={() => setShowCashDrop(true)} />
        <ActionButton label="Orders"     desc="Phone orders + route conversion"  onClick={() => onNavigate({ name: 'pending-orders' })} />
        <ActionButton label="Route runs" desc="Open/close runs; assign orders"    onClick={() => onNavigate({ name: 'route-runs' })} />
        <ActionButton label="Stocktake"  desc="Cycle counting and adjustments"    onClick={() => onNavigate({ name: 'stocktake' })} />
        <ActionButton label="Settings"   desc="Loyalty, workers, products, backup" onClick={() => onNavigate({ name: 'settings' })} />
        <ActionButton label="Close shift" desc="Count the till and sign out" onClick={() => void closeShift()} />
      </div>
      </div>

      {closingError && (
        <div className="mx-6 mb-6 border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {closingError}
        </div>
      )}

      <div className="border-t border-border bg-bg-surface px-6 py-3 max-h-48 overflow-auto">
        <div className="text-xs text-text-secondary uppercase tracking-wider mb-2">
          Recent sales
          <span className="ml-2 text-text-tertiary normal-case">(click to view, print, or void)</span>
        </div>
        {recent.length === 0 ? (
          <div className="text-text-tertiary text-sm">No sales yet.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {recent.map((s) => (
                <tr key={s.id}
                    onClick={() => setSelectedSaleId(s.id)}
                    className={[
                      'border-t border-border first:border-t-0 cursor-pointer hover:bg-bg-elevated',
                      s.voided ? 'opacity-60' : '',
                    ].join(' ')}>
                  <td className="py-1 text-text-tertiary text-xs">
                    {new Date(s.createdAt).toLocaleString()}
                  </td>
                  <td className="py-1">
                    {s.customerName ?? <span className="text-text-tertiary">Walk-in</span>}
                  </td>
                  <td className="py-1 text-right font-mono tnum">
                    {s.voided ? <span className="text-danger">VOID</span> : `₵${formatMoney(s.totalPesewas)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCashDrop && (
        <CashDropModal
          onClose={() => setShowCashDrop(false)}
          onRecorded={() => { setShowCashDrop(false); }}
        />
      )}

      {selectedSaleId && (
        <SaleDetailModal
          saleId={selectedSaleId}
          onClose={() => setSelectedSaleId(null)}
          onChanged={() => { void refreshRecent(); }}
        />
      )}
    </div>
  );
}

function ActionButton({ label, desc, onClick, accent = false }: {
  label: string; desc: string; onClick: () => void; accent?: boolean;
}): JSX.Element {
  return (
    <button onClick={onClick}
      className={[
        'p-6 text-left border transition-colors',
        accent
          ? 'bg-accent text-bg-deep border-accent hover:bg-accent/90'
          : 'bg-bg-surface border-border hover:bg-bg-elevated',
      ].join(' ')}
    >
      <div className="text-2xl font-semibold">{label}</div>
      <div className={`text-sm mt-1 ${accent ? 'text-bg-deep/70' : 'text-text-tertiary'}`}>
        {desc}
      </div>
    </button>
  );
}
