// SettingsLoyalty.tsx — Wave H. Settings → Loyalty tab.
//
// OWNER-only writes; lower roles see the table read-only with the
// edit/add/deactivate buttons visible-but-disabled (Section 11 pattern,
// matching CustomerPerformanceTab's "Edit tier" affordance).
//
// Two surfaces:
//   1. Threshold table — one row per active rule. The unique partial
//      index on (tier, metric, window_days) means upsert with the same
//      key edits in place rather than inserting a duplicate. The UI
//      enforces this by routing "Edit" to upsertThreshold with id, and
//      "Add" to upsertThreshold without id.
//   2. Preview widget — pick a customer (by id, the simplest input that
//      doesn't drag the whole CustomersScreen search behaviour into this
//      tab), see what they'd compute to under the current rules, and
//      see whether a manual override is in effect.
//
// Wired to:
//   counter.listLoyaltyThresholds, upsertLoyaltyThreshold,
//   deactivateLoyaltyThreshold, previewTier.
// Audit-log rows are written by the IPC handler, not the renderer.

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import type {
  LoyaltyTier, LoyaltyMetric, ThresholdRow,
} from '../../main/services/loyaltyTiers';

type EditState =
  | { mode: 'add' }
  | { mode: 'edit'; row: ThresholdRow };

const TIER_OPTIONS: LoyaltyTier[] = ['VIP', 'GOLD', 'SILVER', 'STANDARD'];
const METRIC_OPTIONS: Array<{ value: LoyaltyMetric; label: string; isMoney: boolean }> = [
  { value: 'REVENUE_PESEWAS', label: 'Revenue (cedis in window)',  isMoney: true  },
  { value: 'MARGIN_PESEWAS',  label: 'Margin (cedis in window)',   isMoney: true  },
  { value: 'ORDER_COUNT',     label: 'Order count (in window)',    isMoney: false },
];

function isMoneyMetric(metric: LoyaltyMetric): boolean {
  return metric === 'REVENUE_PESEWAS' || metric === 'MARGIN_PESEWAS';
}

function formatThresholdValue(row: ThresholdRow): string {
  if (isMoneyMetric(row.metric)) {
    return `≥ ${formatMoney(row.minValue)}`;
  }
  return `≥ ${row.minValue}`;
}

function formatMetricLabel(metric: LoyaltyMetric): string {
  return METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? metric;
}

export default function SettingsLoyalty(): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';

  const [rows, setRows] = useState<ThresholdRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    const r = await counter.listLoyaltyThresholds({ includeInactive: false });
    if (!r.success) setError(r.error);
    else setRows(r.data.thresholds);
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, []);

  async function deactivate(row: ThresholdRow) {
    if (!isOwner) return;
    if (!confirm(
      `Deactivate ${row.tier} threshold (${formatMetricLabel(row.metric)}, ` +
      `last ${row.windowDays} days, ${formatThresholdValue(row)})?\n\n` +
      'Customers currently in this tier may drop to a lower computed tier ' +
      'or to no tier at all until a replacement is added.',
    )) return;
    const r = await counter.deactivateLoyaltyThreshold({ id: row.id });
    if (!r.success) setError(r.error);
    else void refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header --------------------------------------------------------- */}
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-lg font-semibold">Loyalty thresholds</div>
          <div className="text-sm text-text-tertiary mt-1">
            Customers compute to a tier when they clear the threshold for that
            tier. Highest tier wins (VIP &gt; GOLD &gt; SILVER &gt; STANDARD).
            Manual tiers on a customer always override the computed tier.
          </div>
        </div>
        <button
          disabled={!isOwner}
          onClick={() => setEditState({ mode: 'add' })}
          title={!isOwner ? 'OWNER role required to add thresholds' : ''}
          className={[
            'text-sm px-3 py-2 border',
            isOwner
              ? 'border-accent text-accent hover:bg-accent hover:text-bg-deep'
              : 'border-border text-text-tertiary cursor-not-allowed opacity-60',
          ].join(' ')}
        >
          + Add threshold
        </button>
      </div>

      {/* Error / loading ------------------------------------------------ */}
      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-4 py-3 rounded text-sm">
          {error}
        </div>
      )}

      {/* Thresholds table ----------------------------------------------- */}
      <div className="bg-bg-surface border border-border">
        {loading && rows.length === 0 ? (
          <div className="px-4 py-6 text-text-tertiary text-sm text-center">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6 text-text-tertiary text-sm text-center">
            No active thresholds. Customers will have no computed tier until you add at least one.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary uppercase tracking-wider text-xs">
                <th className="px-4 py-2 text-left">Tier</th>
                <th className="px-4 py-2 text-left">Metric</th>
                <th className="px-4 py-2 text-right">Window</th>
                <th className="px-4 py-2 text-right">Threshold</th>
                <th className="px-4 py-2 text-left">Notes</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="px-4 py-2 font-semibold">{row.tier}</td>
                  <td className="px-4 py-2">{formatMetricLabel(row.metric)}</td>
                  <td className="px-4 py-2 text-right font-mono tnum">{row.windowDays}d</td>
                  <td className="px-4 py-2 text-right font-mono tnum">{formatThresholdValue(row)}</td>
                  <td className="px-4 py-2 text-text-tertiary text-xs">{row.notes ?? ''}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex gap-2">
                      <button
                        disabled={!isOwner}
                        onClick={() => setEditState({ mode: 'edit', row })}
                        title={!isOwner ? 'OWNER role required to edit thresholds' : ''}
                        className={[
                          'text-xs px-2 py-1 border',
                          isOwner
                            ? 'border-border hover:bg-bg-elevated'
                            : 'border-border text-text-tertiary cursor-not-allowed opacity-60',
                        ].join(' ')}
                      >
                        Edit
                      </button>
                      <button
                        disabled={!isOwner}
                        onClick={() => void deactivate(row)}
                        title={!isOwner ? 'OWNER role required to deactivate' : ''}
                        className={[
                          'text-xs px-2 py-1 border',
                          isOwner
                            ? 'border-danger text-danger hover:bg-danger hover:text-bg-deep'
                            : 'border-border text-text-tertiary cursor-not-allowed opacity-60',
                        ].join(' ')}
                      >
                        Deactivate
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Preview widget ------------------------------------------------- */}
      <PreviewTierWidget />

      {/* Add/edit modal ------------------------------------------------- */}
      {editState && (
        <ThresholdFormModal
          state={editState}
          existingRows={rows}
          onClose={() => setEditState(null)}
          onSaved={() => { setEditState(null); void refresh(); }}
        />
      )}
    </div>
  );
}

// --- Preview widget --------------------------------------------------------

function PreviewTierWidget(): JSX.Element {
  const [customerId, setCustomerId] = useState('');
  const [result, setResult] = useState<{
    manual: LoyaltyTier | null;
    computed: LoyaltyTier | null;
    effective: LoyaltyTier | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function preview() {
    setLoading(true);
    setError(null);
    setResult(null);
    const r = await counter.previewTier({ customerId: customerId.trim() });
    setLoading(false);
    if (!r.success) setError(r.error);
    else setResult(r.data);
  }

  return (
    <div className="bg-bg-surface border border-border p-4">
      <div className="text-text-secondary uppercase tracking-wider text-xs mb-2">
        Preview tier for customer
      </div>
      <div className="text-text-tertiary text-xs mb-3">
        Enter a customer id (e.g. <span className="font-mono tnum">cust-…</span>) to
        see what they'd compute to under the current threshold rules.
      </div>
      <div className="flex items-center gap-2">
        <input
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          placeholder="cust-..."
          className="flex-1 bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum"
        />
        <button
          disabled={!customerId.trim() || loading}
          onClick={() => void preview()}
          className="text-sm px-3 py-2 border border-accent text-accent hover:bg-accent hover:text-bg-deep disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Preview
        </button>
      </div>
      {error && (
        <div className="mt-3 border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}
      {result && (
        <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
          <ResultCell label="Manual" value={result.manual} />
          <ResultCell label="Computed" value={result.computed} />
          <ResultCell label="Effective" value={result.effective} highlight />
        </div>
      )}
    </div>
  );
}

function ResultCell({
  label, value, highlight = false,
}: {
  label: string;
  value: LoyaltyTier | null;
  highlight?: boolean;
}): JSX.Element {
  return (
    <div className="bg-bg-deep border border-border p-3">
      <div className="text-text-tertiary text-xs uppercase tracking-wider">{label}</div>
      <div className={[
        'text-lg font-semibold mt-1',
        value ? (highlight ? 'text-accent' : 'text-text-primary') : 'text-text-tertiary',
      ].join(' ')}>
        {value ?? '—'}
      </div>
    </div>
  );
}

// --- Add / edit modal ------------------------------------------------------

function ThresholdFormModal({
  state, existingRows, onClose, onSaved,
}: {
  state: EditState;
  existingRows: ThresholdRow[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const editing = state.mode === 'edit' ? state.row : null;

  const [tier, setTier] = useState<LoyaltyTier>(editing?.tier ?? 'GOLD');
  const [metric, setMetric] = useState<LoyaltyMetric>(editing?.metric ?? 'REVENUE_PESEWAS');
  const [windowDays, setWindowDays] = useState<string>(
    editing ? String(editing.windowDays) : '90',
  );
  // For money metrics we display in cedis. Initial value:
  //   editing money: minValue is pesewas → divide by 100.
  //   editing count: minValue is the count.
  //   adding: blank.
  const [valueInput, setValueInput] = useState<string>(() => {
    if (!editing) return '';
    return isMoneyMetric(editing.metric)
      ? (editing.minValue / 100).toFixed(2)
      : String(editing.minValue);
  });
  const [notes, setNotes] = useState<string>(editing?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // When the user changes metric while adding, reset the input — switching
  // between cedis and count makes the previous value meaningless.
  function onMetricChange(next: LoyaltyMetric) {
    setMetric(next);
    if (!editing) setValueInput('');
  }

  // Detect duplicate (tier, metric, windowDays) when adding. The unique
  // partial index will catch it, but a clear UI message is nicer than
  // SQLITE_CONSTRAINT bubbling up.
  const conflictRow = useMemo(() => {
    const days = parseInt(windowDays, 10);
    if (!Number.isFinite(days)) return null;
    return existingRows.find((r) =>
      r.tier === tier && r.metric === metric && r.windowDays === days &&
      (!editing || r.id !== editing.id),
    ) ?? null;
  }, [tier, metric, windowDays, existingRows, editing]);

  async function save() {
    setError(null);
    const days = parseInt(windowDays, 10);
    if (!Number.isFinite(days) || days <= 0) {
      setError('Window must be a positive number of days.');
      return;
    }
    let minValue: number;
    if (isMoneyMetric(metric)) {
      try {
        minValue = parseCedisToPesewas(valueInput);
      } catch (e: any) {
        setError(e?.message ?? 'Invalid amount.');
        return;
      }
    } else {
      const n = parseInt(valueInput, 10);
      if (!Number.isFinite(n) || n < 0) {
        setError('Order count must be a non-negative integer.');
        return;
      }
      minValue = n;
    }
    if (conflictRow) {
      setError(
        `An active ${tier} threshold already exists for this metric and window. ` +
        'Edit that row instead, or deactivate it first.',
      );
      return;
    }

    setSaving(true);
    const r = await counter.upsertLoyaltyThreshold({
      id: editing?.id,
      tier,
      metric,
      windowDays: days,
      minValue,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (!r.success) setError(r.error);
    else onSaved();
  }

  const valueLabel = isMoneyMetric(metric) ? 'Minimum cedis in window' : 'Minimum order count';
  const valuePlaceholder = isMoneyMetric(metric) ? 'e.g. 5000.00' : 'e.g. 1';

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">
            {editing ? 'Edit threshold' : 'Add threshold'}
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>
        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
              {error}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Tier</label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as LoyaltyTier)}
              disabled={!!editing}      /* tier is part of the unique key — can't repurpose a row */
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm disabled:opacity-60"
            >
              {TIER_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {editing && (
              <div className="text-xs text-text-tertiary">
                Tier, metric and window are part of the rule's identity. To change them,
                deactivate this row and add a new one.
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Metric</label>
            <select
              value={metric}
              onChange={(e) => onMetricChange(e.target.value as LoyaltyMetric)}
              disabled={!!editing}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm disabled:opacity-60"
            >
              {METRIC_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Window (days)</label>
            <input
              type="number"
              min="1"
              value={windowDays}
              onChange={(e) => setWindowDays(e.target.value)}
              disabled={!!editing}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum disabled:opacity-60"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">{valueLabel}</label>
            <input
              value={valueInput}
              onChange={(e) => setValueInput(e.target.value)}
              placeholder={valuePlaceholder}
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Notes (optional)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. raised after Q1 review"
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
            />
          </div>

          {conflictRow && !editing && (
            <div className="border border-warning bg-warning/10 text-warning px-3 py-2 text-sm rounded">
              An active {conflictRow.tier} threshold already exists for this
              metric and window ({formatThresholdValue(conflictRow)}). Edit
              that row instead, or deactivate it first.
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving || !!conflictRow}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : (editing ? 'Save changes' : 'Add threshold')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
