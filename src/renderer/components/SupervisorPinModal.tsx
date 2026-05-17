// SupervisorPinModal — purpose-bound supervisor-PIN elevation dialog.
//
// Used wherever a cashier-triggered action needs supervisor approval:
// over-credit-limit partial payments, over-threshold discounts,
// breakage write-offs, sale voids, customer returns. The caller picks
// a `purpose` (one of the SupervisorApprovalPurpose values) and an
// optional `context` snapshot (customer id, amount delta, etc.) that
// gets stored on the approval row for the audit trail.
//
// On submit the PIN is verified server-side against every active
// SUPERVISOR/OWNER/FOUNDER pin_hash; on success a single-use,
// time-bounded `supervisor_approvals` row is created and its id is
// returned via onApproved. The caller threads that id into the
// downstream service call (e.g. createSale's supervisorApprovalId).
//
// On failure the modal shows a deliberately vague "Incorrect PIN."
// message — the server already audit-logged the attempt with the
// cashier's worker id.

import { useState } from 'react';
import { counter } from '../lib/ipc';
import type {
  SupervisorApprovalPurpose, SupervisorVerifyPinResponse,
} from '../../shared/types/ipc';

interface Props {
  purpose: SupervisorApprovalPurpose;
  // Human-readable rationale displayed under the title so the
  // supervisor knows what they're approving before they type the PIN.
  // Example: "This sale would put Mama Akua at ₵620 owed, above the
  // ₵500 credit limit."
  reason: string;
  // JSON-serialisable snapshot of the decision context. Stored on the
  // approval row for forensic readers months later.
  context?: Record<string, unknown>;
  onClose: () => void;
  onApproved: (response: SupervisorVerifyPinResponse) => void;
}

const PURPOSE_LABEL: Record<SupervisorApprovalPurpose, string> = {
  OVER_LIMIT_PARTIAL: 'Approve over-limit credit',
  OVER_THRESHOLD_DISCOUNT: 'Approve discount',
  BREAKAGE: 'Approve breakage write-off',
  VOID_SALE: 'Approve sale void',
  CUSTOMER_RETURN: 'Approve customer return',
  STOCKTAKE_LARGE_DELTA: 'Approve stocktake adjustment',
};

export default function SupervisorPinModal({
  purpose, reason, context, onClose, onApproved,
}: Props): JSX.Element {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (pin.length < 4) {
      setError('PIN must be at least 4 digits.');
      return;
    }
    setBusy(true);
    const r = await counter.verifySupervisorPin({ pin, purpose, context });
    setBusy(false);
    if (!r.success) {
      setError(r.error);
      // Clear the PIN field on failure so the supervisor can retry
      // without first selecting-and-clearing. Standard PIN-modal
      // convention.
      setPin('');
      return;
    }
    onApproved(r.data);
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">{PURPOSE_LABEL[purpose]}</div>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary"
            aria-label="Close"
          >×</button>
        </div>
        <div className="p-6 space-y-4">
          <div className="text-sm text-text-secondary">
            {reason}
          </div>
          <div className="text-xs text-text-tertiary border-t border-border pt-3">
            A supervisor must enter their PIN to approve this. The
            approval is recorded against their worker id and is
            single-use.
          </div>
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
              {error}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Supervisor PIN</label>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) {
                  e.preventDefault();
                  void submit();
                }
              }}
              autoFocus
              className="w-full bg-bg-deep border border-border px-3 py-2 font-mono tnum tracking-[0.3em] text-center text-lg"
              placeholder="••••"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy || pin.length < 4}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Approve'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
