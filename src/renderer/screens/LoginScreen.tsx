// LoginScreen — pick a worker, enter PIN. The first-run default OWNER's
// PIN is 1234 (seeded by src/main/db/seed.ts); we surface that here as
// a hint so dad doesn't get stuck.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import type { WorkerSummary } from '../../shared/types/ipc';

interface Props { onLoggedIn: () => void }

export default function LoginScreen({ onLoggedIn }: Props): JSX.Element {
  const setSession = useSession((s) => s.setSession);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [workerId, setWorkerId] = useState<string>('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await counter.listWorkers();
      if (r.success) {
        setWorkers(r.data.workers);
        if (r.data.workers.length > 0) setWorkerId(r.data.workers[0]!.id);
      }
    })();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!workerId || !pin) return;
    setBusy(true); setError(null);
    const r = await counter.login({ workerId, pin });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    setSession(r.data.session);
    onLoggedIn();
  }

  const onlyDefaultOwner = workers.length === 1 && workers[0]!.role === 'OWNER';

  return (
    <div className="h-full flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm bg-bg-surface border border-border p-6 space-y-4 rounded">
        <div>
          <div className="text-2xl font-semibold tracking-tight">Counter</div>
          <div className="text-text-tertiary text-sm">Sign in to continue</div>
        </div>

        {error && (
          <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
            {error}
          </div>
        )}

        <div className="space-y-1">
          <label className="text-xs text-text-secondary">Worker</label>
          <select
            value={workerId}
            onChange={(e) => setWorkerId(e.target.value)}
            className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
          >
            {workers.map((w) => (
              <option key={w.id} value={w.id}>{w.fullName} — {w.role}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-text-secondary">PIN</label>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
            className="w-full bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum tracking-[0.3em] text-center text-lg"
            placeholder="••••"
          />
        </div>

        <button
          type="submit"
          disabled={busy || !workerId || !pin}
          className="w-full bg-accent text-bg-deep font-semibold px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {onlyDefaultOwner && (
          <div className="text-xs text-text-tertiary border-t border-border pt-3">
            <strong className="text-text-secondary">First run:</strong> the demo OWNER PIN is
            <span className="font-mono tnum text-accent"> 1234</span>. Change it from
            Settings once you're set up.
          </div>
        )}
      </form>
    </div>
  );
}
