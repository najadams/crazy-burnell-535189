// OpenShiftScreen — opening cash count. Section 8 of CLAUDE.md.
//
// Single-location demo: the main process resolves the default active
// location automatically when the renderer doesn't name one (see the
// SHIFT_OPEN handler). When multi-location lands, this screen gets a
// dropdown.

import { useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { parseCedisToPesewas } from '../../shared/lib/money';

interface Props { onOpened: () => void }

export default function OpenShiftScreen({ onOpened }: Props): JSX.Element {
  const fullName = useSession((s) => s.fullName);
  const setSession = useSession((s) => s.setSession);
  const [opening, setOpening] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const pesewas = parseCedisToPesewas(opening || '0');
      const r = await counter.openShift({ openingAmountPesewas: pesewas });
      setBusy(false);
      if (!r.success) { setError(r.error); return; }
      onOpened();
    } catch (err: any) {
      setBusy(false);
      setError(err?.message ?? 'Could not parse the cash amount.');
    }
  }

  async function logout() {
    await counter.logout();
    setSession(null);
  }

  return (
    <div className="h-full flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm bg-bg-surface border border-border p-6 space-y-4 rounded">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-2xl font-semibold tracking-tight">Open shift</div>
            <div className="text-text-tertiary text-sm mt-1">
              Welcome, {fullName ?? 'worker'}.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="text-xs text-text-tertiary hover:text-text-primary underline-offset-2 hover:underline"
          >
            Sign out
          </button>
        </div>

        <div className="text-sm text-text-tertiary">
          Count the till and enter the opening amount in cedis. This is the
          baseline the closing count is checked against.
        </div>

        {error && (
          <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
            {error}
          </div>
        )}

        <div className="space-y-1">
          <label className="text-xs text-text-secondary">Opening cash (cedis)</label>
          <input
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
            autoFocus
            placeholder="0.00"
            className="w-full bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum"
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-accent text-bg-deep font-semibold px-4 py-2 disabled:opacity-50"
        >
          {busy ? 'Opening…' : 'Open shift'}
        </button>
      </form>
    </div>
  );
}
