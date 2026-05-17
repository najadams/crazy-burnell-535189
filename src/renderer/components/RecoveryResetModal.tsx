// RecoveryResetModal — the "Forgot PIN" flow.
//
// Three-step inline wizard:
//   1. Pick the OWNER/FOUNDER worker whose PIN is being reset.
//      (The picker comes from RECOVERY_LIST_ELIGIBLE — unauthenticated
//      because by definition the user is locked out.)
//   2. Enter the 16-character recovery code (hyphens/case optional).
//   3. Enter the new PIN twice.
//
// On submit: RECOVERY_VERIFY_AND_RESET. On success, the parent gets
// the new plaintext recovery code via onSucceeded; it should display
// RecoveryIssuedModal so the user writes the new code down BEFORE
// closing.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';

interface EligibleWorker {
  id: string;
  fullName: string;
  role: 'OWNER' | 'FOUNDER';
  hasRecoveryCode: boolean;
}

interface Props {
  onClose: () => void;
  // Called with the newly-issued recovery code so the caller can
  // present it via RecoveryIssuedModal. The new PIN is already
  // persisted at this point.
  onSucceeded: (input: { workerId: string; newRecoveryCode: string }) => void;
}

export default function RecoveryResetModal({
  onClose, onSucceeded,
}: Props): JSX.Element {
  const [workers, setWorkers] = useState<EligibleWorker[]>([]);
  const [workerId, setWorkerId] = useState<string>('');
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await counter.listRecoveryEligible();
      if (r.success) {
        setWorkers(r.data.workers);
        // Auto-select if only one eligible worker (common single-OWNER
        // case) so the user can go straight to typing the code.
        if (r.data.workers.length === 1) setWorkerId(r.data.workers[0].id);
      } else {
        setError(r.error);
      }
    })();
  }, []);

  async function submit() {
    setError(null);
    if (!workerId) { setError('Pick the worker whose PIN you want to reset.'); return; }
    if (!code.trim()) { setError('Type the recovery code.'); return; }
    if (newPin.length < 4) { setError('New PIN must be at least 4 digits.'); return; }
    if (newPin !== confirmPin) { setError('PIN confirmation does not match.'); return; }
    setBusy(true);
    const r = await counter.recoveryResetPin({ workerId, code: code.trim(), newPin });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    onSucceeded({ workerId, newRecoveryCode: r.data.newRecoveryCode });
  }

  const selectedWorker = workers.find((w) => w.id === workerId);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">Forgot PIN — reset with recovery code</div>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary"
            aria-label="Close"
          >×</button>
        </div>

        <div className="p-6 space-y-4">
          {workers.length === 0 ? (
            <div className="text-sm text-text-tertiary">
              No OWNER or FOUNDER workers are set up. Recovery only
              applies to top-level accounts.
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs text-text-secondary">Worker</label>
                <select
                  value={workerId}
                  onChange={(e) => setWorkerId(e.target.value)}
                  className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
                  autoFocus={workers.length > 1}
                >
                  <option value="">— pick worker —</option>
                  {workers.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.fullName} ({w.role})
                      {!w.hasRecoveryCode ? ' — no code on file' : ''}
                    </option>
                  ))}
                </select>
                {selectedWorker && !selectedWorker.hasRecoveryCode && (
                  <div className="text-xs text-warning mt-1">
                    This worker has no recovery code on file. An OWNER
                    must regenerate from Settings → Workers before this
                    flow can be used.
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-xs text-text-secondary">Recovery code</label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  autoFocus={workers.length === 1}
                  className="w-full bg-bg-deep border border-border px-3 py-2 font-mono tnum tracking-[0.15em] text-center"
                />
                <div className="text-xs text-text-tertiary">
                  Hyphens and case don't matter; spaces are ignored.
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-text-secondary">New PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  className="w-full bg-bg-deep border border-border px-3 py-2 font-mono tnum tracking-[0.3em] text-center text-lg"
                  placeholder="••••"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-text-secondary">Confirm new PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) { e.preventDefault(); void submit(); }
                  }}
                  className="w-full bg-bg-deep border border-border px-3 py-2 font-mono tnum tracking-[0.3em] text-center text-lg"
                  placeholder="••••"
                />
              </div>

              {error && (
                <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={onClose}
                  disabled={busy}
                  className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated disabled:opacity-50"
                >Cancel</button>
                <button
                  onClick={() => void submit()}
                  disabled={busy || !workerId || !code.trim() || newPin.length < 4}
                  className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50"
                >
                  {busy ? 'Resetting…' : 'Reset PIN'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
