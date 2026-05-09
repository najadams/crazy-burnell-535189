// CustomerLeaderboardView — Wave H. Ranks customers by revenue / margin /
// order count over an owner-chosen window. The OWNER opens this to answer
// "who matters most this period and who's slipping?" — the route business's
// most operationally important question.
//
// Self-contained: holds its own filter state, fetches via
// counter.customerLeaderboard, renders the table. The parent passes
// `onSelectCustomer(customerId)` so clicking a row drills into the
// per-customer detail screen.
//
// Integration: replace or toggle alongside the existing alphabetical
// customer list on CustomersScreen. See WAVE_H_INTEGRATION.md.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';
import type { LeaderboardRow } from '../../main/services/customerLeaderboard';
import type { LoyaltyTier } from '../../main/services/loyaltyTiers';

type Metric = 'REVENUE_PESEWAS' | 'MARGIN_PESEWAS' | 'ORDER_COUNT';
type ChannelFilter = '' | 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

interface Props {
  onSelectCustomer: (customerId: string) => void;
}

const WINDOW_CHOICES: Array<{ label: string; days: number }> = [
  { label: '30d',  days: 30 },
  { label: '60d',  days: 60 },
  { label: '90d',  days: 90 },
  { label: '180d', days: 180 },
  { label: '365d', days: 365 },
];

const METRIC_LABELS: Record<Metric, string> = {
  REVENUE_PESEWAS: 'Revenue',
  MARGIN_PESEWAS:  'Margin',
  ORDER_COUNT:     'Orders',
};

function fmtDays(d: number | null): string {
  if (d === null) return 'never';
  if (d < 1) return '<1d';
  return `${Math.round(d)}d`;
}

function metricCellValue(row: LeaderboardRow, metric: Metric): string {
  if (metric === 'ORDER_COUNT') return String(row.metricValue);
  return formatMoneyWithCurrency(row.metricValue);
}

function engagementClasses(state: LeaderboardRow['engagementState']): string {
  switch (state) {
    case 'ACTIVE':   return 'text-success';
    case 'SLIPPING': return 'text-warning';
    case 'DORMANT':  return 'text-danger';
    case 'NEW':      return 'text-accent';
    default:         return 'text-text-tertiary';
  }
}

function rowBgClasses(state: LeaderboardRow['engagementState']): string {
  switch (state) {
    case 'SLIPPING': return 'bg-warning/5 hover:bg-warning/10';
    case 'DORMANT':  return 'bg-danger/5 hover:bg-danger/10';
    default:         return 'hover:bg-bg-elevated';
  }
}

function tierClasses(tier: LoyaltyTier | null): string {
  switch (tier) {
    case 'VIP':      return 'bg-accent/20 text-accent border-accent/40';
    case 'GOLD':     return 'bg-warning/20 text-warning border-warning/40';
    case 'SILVER':   return 'bg-bg-elevated text-text-secondary border-border';
    case 'STANDARD': return 'bg-transparent text-text-tertiary border-border/60';
    default:         return 'bg-transparent text-text-tertiary border-border/40';
  }
}

export default function CustomerLeaderboardView({ onSelectCustomer }: Props): JSX.Element {
  const [windowDays, setWindowDays] = useState<number>(90);
  const [metric, setMetric]         = useState<Metric>('REVENUE_PESEWAS');
  const [channel, setChannel]       = useState<ChannelFilter>('');
  const [includeBlocked, setIncludeBlocked] = useState(false);
  const [limit, setLimit]           = useState<number>(50);

  const [rows, setRows]   = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    const now = new Date();
    const start = new Date(now.getTime() - windowDays * 86400_000);
    const r = await counter.customerLeaderboard({
      windowStartISO: start.toISOString(),
      windowEndISO:   now.toISOString(),
      metric,
      limit,
      includeBlocked,
      ...(channel ? { channel } : {}),
    });
    if (!r.success) setError(r.error);
    else setRows(r.data.rows);
    setLoading(false);
  }

  useEffect(() => { void refresh(); },
    [windowDays, metric, channel, includeBlocked, limit]);

  const slippingCount = rows.filter((r) => r.engagementState === 'SLIPPING').length;
  const dormantCount  = rows.filter((r) => r.engagementState === 'DORMANT').length;

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar -------------------------------------------------------- */}
      <div className="flex flex-wrap items-end gap-4 bg-bg-surface border border-border p-3">
        <div>
          <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Window</div>
          <div className="flex gap-1">
            {WINDOW_CHOICES.map((c) => (
              <button
                key={c.days}
                onClick={() => setWindowDays(c.days)}
                className={[
                  'px-2 py-1 text-sm border',
                  c.days === windowDays
                    ? 'bg-accent text-bg-deep border-accent'
                    : 'bg-bg-deep border-border hover:bg-bg-elevated',
                ].join(' ')}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-text-secondary uppercase tracking-wider mb-1 block">Sort by</label>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as Metric)}
            className="bg-bg-deep border border-border px-3 py-1.5 text-sm"
          >
            <option value="REVENUE_PESEWAS">Revenue</option>
            <option value="MARGIN_PESEWAS">Margin</option>
            <option value="ORDER_COUNT">Order count</option>
          </select>
        </div>

        <div>
          <label className="text-xs text-text-secondary uppercase tracking-wider mb-1 block">Channel</label>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as ChannelFilter)}
            className="bg-bg-deep border border-border px-3 py-1.5 text-sm"
          >
            <option value="">All</option>
            <option value="WALK_IN">Walk-in</option>
            <option value="WHOLESALE">Wholesale</option>
            <option value="ROUTE">Route</option>
          </select>
        </div>

        <div>
          <label className="text-xs text-text-secondary uppercase tracking-wider mb-1 block">Show top</label>
          <select
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value, 10))}
            className="bg-bg-deep border border-border px-3 py-1.5 text-sm"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={250}>250</option>
          </select>
        </div>

        <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={includeBlocked}
            onChange={(e) => setIncludeBlocked(e.target.checked)}
            className="accent-accent"
          />
          Include blocked
        </label>

        <div className="ml-auto flex items-center gap-3 text-xs">
          {slippingCount > 0 && (
            <span className="text-warning">
              {slippingCount} slipping
            </span>
          )}
          {dormantCount > 0 && (
            <span className="text-danger">
              {dormantCount} dormant
            </span>
          )}
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="px-3 py-1.5 border border-border text-sm hover:bg-bg-elevated disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Body ------------------------------------------------------------- */}
      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-4 py-3 rounded text-sm">
          {error}
        </div>
      )}

      {!error && rows.length === 0 && !loading && (
        <div className="bg-bg-surface border border-border p-8 text-center text-text-tertiary">
          No customers had activity in the selected window.
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-bg-surface border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-xs uppercase tracking-wider border-b border-border">
                <th className="px-3 py-3 text-right w-12">#</th>
                <th className="px-3 py-3 text-left">Customer</th>
                <th className="px-3 py-3 text-right">{METRIC_LABELS[metric]}</th>
                <th className="px-3 py-3 text-right">Orders</th>
                <th className="px-3 py-3 text-right">Last order</th>
                <th className="px-3 py-3 text-left">Cadence</th>
                <th className="px-3 py-3 text-left">Tier</th>
                <th className="px-3 py-3 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.customerId}
                  onClick={() => onSelectCustomer(r.customerId)}
                  className={`border-b border-border last:border-b-0 cursor-pointer ${rowBgClasses(r.engagementState)}`}
                >
                  <td className="px-3 py-3 text-right font-mono tnum text-text-tertiary">
                    {r.rankInWindow}
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-medium">{r.displayName}</div>
                    <div className="text-text-tertiary text-xs font-mono tnum">
                      {r.phone} · {r.customerType}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono tnum font-semibold">
                    {metricCellValue(r, metric)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tnum text-text-secondary">
                    {r.orderCount}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tnum">
                    {fmtDays(r.lastOrderDaysAgo)}
                  </td>
                  <td className={`px-3 py-3 text-sm font-medium ${engagementClasses(r.engagementState)}`}>
                    {r.engagementState ?? '—'}
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={[
                        'inline-block px-2 py-0.5 text-xs border rounded font-medium',
                        tierClasses(r.effectiveTier),
                      ].join(' ')}
                    >
                      {r.effectiveTier ?? 'No tier'}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-text-tertiary text-right">
                    <span aria-hidden>›</span>
                  </td>
                </tr>
              ))}
            </tbody>
            {/* Footer: totals across visible rows */}
            <tfoot className="border-t-2 border-border">
              <tr className="text-text-secondary">
                <td colSpan={2} className="px-3 py-2 text-xs uppercase tracking-wider">
                  Totals (top {rows.length})
                </td>
                <td className="px-3 py-2 text-right font-mono tnum font-semibold">
                  {metric === 'ORDER_COUNT'
                    ? rows.reduce((s, r) => s + r.metricValue, 0)
                    : formatMoneyWithCurrency(rows.reduce((s, r) => s + r.metricValue, 0))}
                </td>
                <td className="px-3 py-2 text-right font-mono tnum">
                  {rows.reduce((s, r) => s + r.orderCount, 0)}
                </td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="text-xs text-text-tertiary">
        Cadence is computed from each customer's own historical rhythm.
        SLIPPING means the most recent gap between orders is 1.5–3× their median;
        DORMANT means it's longer than that or it's been over 60 days.
        Click a row to open that customer.
      </p>
    </div>
  );
}
