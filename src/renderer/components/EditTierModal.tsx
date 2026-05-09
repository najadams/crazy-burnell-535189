// EditTierModal — Wave H. OWNER-only manual-tier write surface.
//
// Promoted from a private inline component on CustomerPerformanceTab.tsx
// to a standalone module so multiple call sites can reuse it:
//   - the Performance tab on CustomerDetailScreen ("Edit tier" button)
//   - the Settings → Loyalty preview widget (set a manual tier directly
//     from the preview row)
//   - any future consumer (leaderboard rows, future Wave I auto-pricing
//     UI that wants to demote a customer)
//
// The role gate for the trigger button lives at the call site (visible-
// but-disabled per Section 11). This component assumes the caller has
// already established `isOwner === true`. If a non-owner somehow opens
// it, the IPC handler's requireOwnerLike() rejects the write — defence
// in depth.

import { useState } from 'react';
import { counter } from '../lib/ipc';
import type { LoyaltyTier } from '../../main/services/loyaltyTiers';

interface Props {
  customerId: string;
  /** Current manual tier on the customer, or null if none set. */
  currentManual: LoyaltyTier | null;
  /** Existing reason text on the manual tier, or null. */
  currentReason: string | null;
  /**
   * Optional: the customer's currently-computed tier. When present, the
   * modal shows it as context so the OWNER can see why a manual override
   * might or might not be needed. Pass null to hide.
   */
  currentComputed?: LoyaltyTier | null;
  onClose: () => void;
  onSaved: () => void;
}

const TIER_OPTIONS: LoyaltyTier[] = ['VIP', 'GOLD', 'SILVER', 'STANDARD'];

export default function EditTierModal({
  customerId, currentManual, currentReason, currentComputed,
  onClose, onSaved,
}: Props): JSX.Element {
  const [tier, setTier] = useState<LoyaltyTier | ''>(currentManual ?? '');
  const [reason, setReason] = useState<string>(currentReason ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isClearing = !tier;
  const noChange =
    (tier === (currentManual ?? '')) &&
    ((reason.trim() || null) === (currentReason ?? null));

  async function save() {
    setError(null);
    setSaving(true);
    try {
      if (isClearing) {
        // Clear manual override — falls back to computed.
        const r = await counter.clearManualTier({ customerId });
        if (!r.success) { setError(r.error); return; }
      } else {
        const r = await counter.setManualTier({
          customerId,
          tier: tier as LoyaltyTier,
          reason: reason.trim() || null,
        });
        if (!r.success) { setError(r.error); return; }
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  // Esc key closes the modal — keyboard-first POS, every modal should
  // honour this. The matching mounted-state pattern lives at the call
  // site, so we only attach the handler while open.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50"
      onKeyDown={onKeyDown}
    >
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">Edit loyalty tier</div>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary"
            aria-label="Close"
          >×</button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
              {error}
            </div>
          )}

          {currentComputed !== undefined && (
            <div className="bg-bg-deep border border-border px-3 py-2 text-xs text-text-tertiary">
              Current computed tier:{' '}
              <span className="font-mono tnum text-text-primary">
                {currentComputed ?? 'insufficient data'}
              </span>
              {currentManual && (
                <>
                  {' · '}current manual:{' '}
                  <span className="font-mono tnum text-accent">{currentManual}</span>
                </>
              )}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Manual tier</label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as LoyaltyTier | '')}
              autoFocus
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
            >
              <option value="">— Clear manual tier (use computed) —</option>
              {TIER_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {!isClearing && (
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Reason (optional)</label>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Long-standing relationship"
                className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
              />
              <div className="text-xs text-text-tertiary">
                Stored on the customer's manual-tier record and shown on
                the Performance tab so anyone reviewing the customer can
                see why the manual tier was applied.
              </div>
            </div>
          )}

          {isClearing && currentManual && (
            <div className="text-xs text-text-tertiary">
              Clearing the manual tier returns this customer to the
              computed tier{currentComputed !== undefined ? (
                <> ({currentComputed ?? 'insufficient data'})</>
              ) : null}.
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
              disabled={saving || noChange}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : (isClearing ? 'Clear manual tier' : 'Save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
