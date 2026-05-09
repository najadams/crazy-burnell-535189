// ChangePinModal — change YOUR OWN PIN. The handler verifies the
// caller's old PIN. No supervisor PIN needed; this is a self-service
// affordance so dad can change away from the demo "1234" on first run.

import { useState } from 'react';
import { counter } from '../lib/ipc';

interface Props {
  onClose: () => void;
  onChanged: () => void;
}

export default function ChangePinModal({ onClose, onChanged }: Props): JSX.Element {
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (newPin.length < 4) { setError('New PIN must be at least 4 digits.'); return; }
    if (newPin !== confirmPin) { setError('Confirmation does not match.'); return; }
    if (oldPin === newPin) { setError('New PIN must be different from old PIN.'); return; }
    setBusy(true);
    const r = await counter.changePin({ oldPin, newPin });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    window.alert('PIN changed. Use the new PIN next time you sign in.');
    onChanged();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border flex items-baseline justify-between">
          <div className="text-lg font-semibold">Change PIN</div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>
        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
              {error}
            </div>
          )}
          <PinField label="Current PIN"  value={oldPin}      onChange={setOldPin}      autoFocus />
          <PinField label="New PIN"      value={newPin}      onChange={setNewPin} />
          <PinField label="Confirm new"  value={confirmPin}  onChange={setConfirmPin} />

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated">
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50"
            >
              {busy ? 'Changing…' : 'Change PIN'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PinField({ label, value, onChange, autoFocus = false }: {
  label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean;
}): JSX.Element {
  return (
    <div className="space-y-1">
      <label className="text-xs text-text-secondary">{label}</label>
      <input
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        className="w-full bg-bg-deep border border-border px-3 py-2 font-mono tnum tracking-[0.3em] text-center text-lg"
        placeholder="••••"
      />
    </div>
  );
}
