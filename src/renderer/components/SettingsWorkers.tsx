// SettingsWorkers — show the current worker, change your own PIN,
// and (OWNER-only) regenerate the recovery code that's used by the
// "Forgot PIN" flow on LoginScreen.

import { useState } from 'react';
import { useSession } from '../store/session';
import { counter } from '../lib/ipc';
import ChangePinModal from './ChangePinModal';
import RecoveryIssuedModal from './RecoveryIssuedModal';

export default function SettingsWorkers(): JSX.Element {
  const fullName = useSession((s) => s.fullName);
  const role = useSession((s) => s.workerRole);
  const workerId = useSession((s) => s.workerId);
  const isOwnerLike = role === 'OWNER' || role === 'FOUNDER';

  const [showChange, setShowChange] = useState(false);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function regenerate() {
    if (!workerId) return;
    if (!window.confirm(
      'Generate a new recovery code? The old one will stop working immediately.',
    )) return;
    setBusy(true);
    setError(null);
    const r = await counter.regenerateRecoveryCode({ targetWorkerId: workerId });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    setIssuedCode(r.data.code);
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-lg font-semibold">Your account</div>
        <div className="text-sm text-text-tertiary mt-1">
          You're signed in as <span className="text-text-primary">{fullName}</span>
          {' '}({role}). Change your PIN to anything 4+ digits — this replaces the
          demo's seed PIN of <span className="font-mono tnum text-warning">1234</span>.
        </div>
      </div>
      <button
        onClick={() => setShowChange(true)}
        className="text-sm px-3 py-2 border border-accent text-accent hover:bg-accent hover:text-bg-deep"
      >
        Change PIN
      </button>

      <div className="border-t border-border pt-4">
        <div className="text-lg font-semibold">Recovery code</div>
        <div className="text-sm text-text-tertiary mt-1">
          A 16-character code that lets you reset the PIN if you forget it.
          The current code stays valid until you regenerate. Regenerating
          replaces it immediately — the old code dies.
        </div>
        {!isOwnerLike && (
          <div className="text-xs text-text-tertiary mt-2">
            Recovery codes are issued for OWNER and FOUNDER accounts only.
          </div>
        )}
        <button
          onClick={() => void regenerate()}
          disabled={busy || !isOwnerLike}
          title={!isOwnerLike ? 'OWNER or FOUNDER role required' : ''}
          className={[
            'mt-3 text-sm px-3 py-2 border',
            isOwnerLike
              ? 'border-warning text-warning hover:bg-warning hover:text-bg-deep'
              : 'border-border text-text-tertiary opacity-60 cursor-not-allowed',
          ].join(' ')}
        >
          {busy ? 'Generating…' : 'Regenerate recovery code'}
        </button>
        {error && (
          <div className="mt-2 border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
            {error}
          </div>
        )}
      </div>

      {showChange && (
        <ChangePinModal
          onClose={() => setShowChange(false)}
          onChanged={() => setShowChange(false)}
        />
      )}

      {issuedCode && (
        <RecoveryIssuedModal
          code={issuedCode}
          intro={`New recovery code for ${fullName ?? 'your account'}. The previous code no longer works.`}
          onClose={() => setIssuedCode(null)}
        />
      )}
    </div>
  );
}
