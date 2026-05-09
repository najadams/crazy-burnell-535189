// CustomerPerformanceTab — Wave H. The single highest-leverage screen
// for the route business: revenue / margin / cadence / top SKUs / loyalty
// tier per customer over an owner-selected window. Mounted as a third
// tab alongside the existing "open" and "history" tabs on
// CustomerDetailScreen.
//
// Wired to the Wave H IPC: counter.customerScorecard({ customerId, ... }).
// Manual tier writes are OWNER-gated; the Edit Tier button is visible
// but disabled for lower roles (Section 11 pattern).

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';
import type { CustomerScorecard } from '../../main/services/customerScorecard';
import type { LoyaltyTier } from '../../main/services/loyaltyTiers';
import EditTierModal from './EditTierModal';

interface Props {
  customerId: string;
}

type WindowChoice = { label: string; days: number } | { label: string; custom: true };

const WINDOW_CHOICES: WindowChoice[] = [
  { label: 'Last 30 days',  days: 30 },
  { label: 'Last 60 days',  days: 60 },
  { label: 'Last 90 days',  days: 90 },
  { label: 'Last 180 days', days: 180 },
  { label: 'Last 365 days', days: 365 },
];

function fmtDays(d: number | null): string {
  if (d === null) return '—';
  if (d < 1) return '<1 day';
  if (d < 1.5) return '1 day';
  return `${Math.round(d)} days`;
}

function pct(value: number | null): string {
  if (value === null) return '—';
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function tierBadge(tier: LoyaltyTier | null): string {
  if (!tier) return 'No tier';
  return tier;
}

export default function CustomerPerformanceTab({ customerId }: Props): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';

  const [windowDays, setWindowDays] = useState<number>(90);
  const [data, setData] = useState<CustomerScorecard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEditTier, setShowEditTier] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    const r = await counter.customerScorecard({ customerId, windowDays });
    if (!r.success) setError(r.error);
    else setData(r.data.scorecard);
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, [customerId, windowDays]);

  const trendTone = useMemo(() => {
    if (!data) return { revenue: '', margin: '', orderCount: '' };
    const tone = (delta: number | null) =>
      delta === null ? 'text-text-tertiary' :
      delta >= 5  ? 'text-success' :
      delta <= -5 ? 'text-danger' : 'text-text-secondary';
    return {
      revenue: tone(data.trend.revenueDeltaPct),
      margin:  tone(data.trend.marginDeltaPct),
      orderCount: tone(data.trend.orderCountDelta * 100),  // reuse threshold heuristic
    };
  }, [data]);

  if (loading && !data) {
    return <div className="text-text-tertiary py-8 text-center">Loading scorecard…</div>;
  }
  if (error) {
    return (
      <div className="border border-danger bg-danger/10 text-danger px-4 py-3 rounded text-sm">
        {error}
      </div>
    );
  }
  if (!data) return <></>;

  const t = data.loyaltyTier;
  const cadence = data.cadence;
  const stateColour =
    cadence.engagementState === 'ACTIVE'   ? 'text-success' :
    cadence.engagementState === 'SLIPPING' ? 'text-warning' :
    cadence.engagementState === 'DORMANT'  ? 'text-danger'  :
    cadence.engagementState === 'NEW'      ? 'text-accent'  :
    'text-text-tertiary';

  return (
    <div className="flex flex-col gap-5">
      {/* Window picker ----------------------------------------------------- */}
      <div className="flex items-center gap-2 flex-wrap">
        {WINDOW_CHOICES.map((c) => (
          <button
            key={c.label}
            onClick={() => 'days' in c && setWindowDays(c.days)}
            className={[
              'px-3 py-1.5 text-sm border',
              'days' in c && c.days === windowDays
                ? 'bg-accent text-bg-deep border-accent'
                : 'bg-bg-surface border-border hover:bg-bg-elevated',
            ].join(' ')}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Headline metrics -------------------------------------------------- */}
      <div className="grid grid-cols-3 gap-3">
        <Headline
          label="Revenue"
          value={formatMoneyWithCurrency(data.revenuePesewas)}
          delta={pct(data.trend.revenueDeltaPct)}
          deltaTone={trendTone.revenue}
          context={`vs ${formatMoney(data.previousWindow.revenuePesewas)} prior ${data.window.days}d`}
        />
        <Headline
          label="Margin"
          value={formatMoneyWithCurrency(data.marginPesewas)}
          delta={pct(data.trend.marginDeltaPct)}
          deltaTone={trendTone.margin}
          context="snapshot at sale time; retroactive cost edits don't affect this"
        />
        <Headline
          label="Orders"
          value={`${data.orderCount}`}
          delta={`${data.trend.orderCountDelta > 0 ? '+' : ''}${data.trend.orderCountDelta}`}
          deltaTone={trendTone.orderCount}
          context={`avg ${formatMoney(data.avgOrderPesewas)} per order`}
        />
      </div>

      {/* Cadence ---------------------------------------------------------- */}
      <div className="bg-bg-surface border border-border p-4">
        <div className="text-text-secondary uppercase tracking-wider text-xs mb-2">Cadence</div>
        <div className="flex items-center gap-6 text-sm">
          <div>
            Last order <span className="font-mono tnum">{fmtDays(cadence.lastOrderDaysAgo)}</span> ago
          </div>
          <div>
            Median gap <span className="font-mono tnum">{fmtDays(cadence.medianDaysBetweenOrders)}</span>
          </div>
          <div className={`font-semibold ${stateColour}`}>
            {cadence.engagementState ?? '—'}
          </div>
        </div>
      </div>

      {/* Top SKUs --------------------------------------------------------- */}
      <div className="bg-bg-surface border border-border">
        <div className="text-text-secondary uppercase tracking-wider text-xs px-4 py-3 border-b border-border">
          Top SKUs in window
        </div>
        {data.topSkus.length === 0 ? (
          <div className="px-4 py-3 text-text-tertiary text-sm">No purchases in window.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {data.topSkus.map((s, i) => (
                <tr key={s.productId} className={i > 0 ? 'border-t border-border' : ''}>
                  <td className="px-4 py-2">{s.productName}</td>
                  <td className="px-4 py-2 text-right font-mono tnum text-text-tertiary">
                    {s.quantitySold} units
                  </td>
                  <td className="px-4 py-2 text-right font-mono tnum">
                    {formatMoney(s.revenuePesewas)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Loyalty tier card ------------------------------------------------ */}
      <div className="bg-bg-surface border border-border p-4">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-text-secondary uppercase tracking-wider text-xs">Loyalty tier</div>
          <button
            disabled={!isOwner}
            onClick={() => setShowEditTier(true)}
            title={!isOwner ? 'OWNER role required to edit loyalty tier' : ''}
            className={[
              'text-sm px-3 py-1 border',
              isOwner
                ? 'border-accent text-accent hover:bg-accent hover:text-bg-deep'
                : 'border-border text-text-tertiary cursor-not-allowed opacity-60',
            ].join(' ')}
          >
            Edit tier
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-text-tertiary text-xs">Effective</div>
            <div className={`text-2xl font-semibold ${t.effective ? 'text-accent' : 'text-text-tertiary'}`}>
              {tierBadge(t.effective)}
            </div>
            {t.manual && (
              <div className="text-text-tertiary text-xs mt-2">
                manual; set {t.manualSetAt ? new Date(t.manualSetAt).toLocaleDateString() : '—'}
                {t.manualSetByName ? ` by ${t.manualSetByName}` : ''}
                {t.manualReason ? ` — "${t.manualReason}"` : ''}
              </div>
            )}
          </div>
          <div>
            <div className="text-text-tertiary text-xs">Computed</div>
            <div className="text-lg font-mono tnum">
              {t.computed ?? 'insufficient data'}
            </div>
            {t.manual && t.computed && t.manual !== t.computed && (
              <div className="text-text-tertiary text-xs mt-1">
                manual override is in effect
              </div>
            )}
          </div>
        </div>
      </div>

      {showEditTier && isOwner && (
        <EditTierModal
          customerId={customerId}
          currentManual={t.manual}
          currentReason={t.manualReason}
          currentComputed={t.computed}
          onClose={() => setShowEditTier(false)}
          onSaved={() => { setShowEditTier(false); void refresh(); }}
        />
      )}
    </div>
  );
}

function Headline({
  label, value, delta, deltaTone, context,
}: {
  label: string; value: string; delta: string; deltaTone: string; context: string;
}): JSX.Element {
  return (
    <div className="bg-bg-surface border border-border p-4">
      <div className="text-text-secondary uppercase tracking-wider text-xs">{label}</div>
      <div className="font-mono tnum text-3xl mt-1">{value}</div>
      <div className={`text-sm mt-1 ${deltaTone}`}>{delta}</div>
      <div className="text-text-tertiary text-xs mt-2">{context}</div>
    </div>
  );
}
