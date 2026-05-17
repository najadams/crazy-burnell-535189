// SettingsDayClose — seal today, see recent seals, reopen if needed.
//
// Section 8 of CLAUDE.md. Sealing today's books prevents any further
// writes against that calendar date — sales, voids, cash drops, and
// customer payments. The expected daily workflow:
//
//   1. End of operating hours: cashier closes shift (separate flow,
//      shifts.ts).
//   2. OWNER reviews the day's totals.
//   3. OWNER taps "Seal today" — books are closed.
//
// Reopen is one-shot per row: if the OWNER notices a correction is
// needed later, they reopen with a reason, fix the underlying record,
// and then — per Section 3 — the row stays in "reopened" state. The
// audit log captures both events for forensic readers.
//
// Buttons are visible-but-disabled for non-OWNER roles, with a
// tooltip explaining why (Section 11 convention).

import { useEffect, useState } from 'react';
import { useSession } from '../store/session';
import { counter } from '../lib/ipc';

interface SealRow {
  id: string;
  locationId: string;
  date: string;
  sealedAt: string;
  sealedBy: string;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
}

function dateOf(iso: string): string { return iso.slice(0, 10); }

export default function SettingsDayClose(): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwnerLike = role === 'OWNER' || role === 'FOUNDER';

  const [locationId, setLocationId] = useState<string | null>(null);
  const [seals, setSeals] = useState<SealRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reopenFor, setReopenFor] = useState<SealRow | null>(null);
  const [reopenReason, setReopenReason] = useState('');

  const today = dateOf(new Date().toISOString());

  async function refresh(loc: string) {
    const r = await counter.listSeals({ locationId: loc, limit: 30 });
    if (r.success) setSeals(r.data.seals);
    else setError(r.error);
  }

  useEffect(() => {
    (async () => {
      const dev = await counter.deviceConfig();
      if (!dev.success) { setError(dev.error); return; }
      if (!dev.data.defaultLocationId) {
        setError('No active location is configured.');
        return;
      }
      setLocationId(dev.data.defaultLocationId);
      await refresh(dev.data.defaultLocationId);
    })();
  }, []);

  // Today's seal — if any
  const todaySeal = seals.find((s) => s.date === today);
  const todayIsSealed = !!todaySeal && todaySeal.reopenedAt === null;

  async function sealToday() {
    if (!locationId) return;
    if (!window.confirm(
      `Seal today (${today})? This blocks any further sales, voids, cash drops, or payments dated today until an OWNER reopens.`,
    )) return;
    setBusy(true); setError(null);
    const r = await counter.sealDay({ locationId, date: today });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    await refresh(locationId);
  }

  async function submitReopen() {
    if (!reopenFor || !locationId) return;
    if (reopenReason.trim().length < 3) {
      setError('A reopen reason is required (at least a few characters).');
      return;
    }
    setBusy(true); setError(null);
    const r = await counter.reopenDay({
      locationId, date: reopenFor.date, reason: reopenReason.trim(),
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    setReopenFor(null);
    setReopenReason('');
    await refresh(locationId);
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-lg font-semibold">Day close</div>
        <div className="text-sm text-text-tertiary mt-1">
          Sealing today's books prevents further changes to today's
          totals — sales, voids, cash drops, and customer payments.
          An OWNER can reopen if a correction is needed, with a
          reason for the audit trail.
        </div>
      </div>

      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}

      <div className="border border-border rounded p-4 space-y-2 bg-bg-elevated">
        <div className="flex items-baseline justify-between">
          <div className="text-sm font-semibold">Today — {today}</div>
          {todayIsSealed
            ? <span className="text-xs text-warning">SEALED at {new Date(todaySeal!.sealedAt).toLocaleTimeString()}</span>
            : <span className="text-xs text-text-tertiary">OPEN</span>}
        </div>
        {!todayIsSealed && (
          <button
            onClick={() => void sealToday()}
            disabled={busy || !isOwnerLike}
            title={!isOwnerLike ? 'OWNER or FOUNDER role required' : ''}
            className={[
              'text-sm px-3 py-2 border',
              isOwnerLike
                ? 'border-warning text-warning hover:bg-warning hover:text-bg-deep'
                : 'border-border text-text-tertiary opacity-60 cursor-not-allowed',
            ].join(' ')}
          >
            {busy ? 'Sealing…' : 'Seal today'}
          </button>
        )}
        {todayIsSealed && (
          <button
            onClick={() => { setReopenFor(todaySeal!); setReopenReason(''); }}
            disabled={!isOwnerLike}
            title={!isOwnerLike ? 'OWNER or FOUNDER role required' : ''}
            className={[
              'text-sm px-3 py-2 border',
              isOwnerLike
                ? 'border-danger text-danger hover:bg-danger hover:text-bg-deep'
                : 'border-border text-text-tertiary opacity-60 cursor-not-allowed',
            ].join(' ')}
          >
            Reopen today
          </button>
        )}
      </div>

      <div>
        <div className="text-sm font-semibold mb-2">Recent seals</div>
        {seals.length === 0 ? (
          <div className="text-sm text-text-tertiary">No days sealed yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-tertiary text-xs uppercase tracking-wider">
                <th className="text-left py-2">Date</th>
                <th className="text-left py-2">State</th>
                <th className="text-left py-2">Sealed at</th>
                <th className="text-right py-2"></th>
              </tr>
            </thead>
            <tbody>
              {seals.map((seal) => (
                <tr key={seal.id} className="border-t border-border">
                  <td className="py-2 font-mono tnum">{seal.date}</td>
                  <td className="py-2">
                    {seal.reopenedAt
                      ? <span className="text-text-tertiary">REOPENED {new Date(seal.reopenedAt).toLocaleDateString()}</span>
                      : <span className="text-warning">SEALED</span>}
                  </td>
                  <td className="py-2 text-text-tertiary">
                    {new Date(seal.sealedAt).toLocaleString()}
                  </td>
                  <td className="py-2 text-right">
                    {!seal.reopenedAt && (
                      <button
                        onClick={() => { setReopenFor(seal); setReopenReason(''); }}
                        disabled={!isOwnerLike}
                        title={!isOwnerLike ? 'OWNER or FOUNDER role required' : ''}
                        className={[
                          'text-xs px-2 py-1 border',
                          isOwnerLike
                            ? 'border-danger text-danger hover:bg-danger hover:text-bg-deep'
                            : 'border-border text-text-tertiary opacity-60 cursor-not-allowed',
                        ].join(' ')}
                      >
                        Reopen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {reopenFor && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
          <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
            <div className="px-6 py-4 border-b border-border">
              <div className="text-lg font-semibold">Reopen {reopenFor.date}</div>
              <div className="text-xs text-text-tertiary mt-1">
                Reopening lets you fix records dated to this day. The
                reopen is one-shot — once you reopen, this seal row is
                permanently in the "reopened" state, and the audit log
                captures both the original seal and this reopen.
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="space-y-1">
                <label className="text-xs text-text-secondary">Reason</label>
                <textarea
                  value={reopenReason}
                  onChange={(e) => setReopenReason(e.target.value)}
                  rows={3}
                  autoFocus
                  className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
                  placeholder="e.g. customer disputed a sale total; need to void and re-ring."
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => { setReopenFor(null); setReopenReason(''); }}
                  disabled={busy}
                  className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated disabled:opacity-50"
                >Cancel</button>
                <button
                  onClick={() => void submitReopen()}
                  disabled={busy || reopenReason.trim().length < 3}
                  className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50"
                >
                  {busy ? 'Reopening…' : 'Reopen day'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
