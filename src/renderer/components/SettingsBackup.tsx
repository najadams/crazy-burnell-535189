// SettingsBackup — manual backup of the live DB to a USB folder via
// VACUUM INTO. No retention or scheduling yet — those are the
// section-9 follow-ups.

import { useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';

export default function SettingsBackup(): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';
  const [targetDir, setTargetDir] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    targetPath: string; sizeBytes: number; timestampISO: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick() {
    setError(null);
    const r = await counter.pickBackupDir();
    if (!r.success) { setError(r.error); return; }
    if (r.data.path) setTargetDir(r.data.path);
  }

  async function run() {
    if (!targetDir) return;
    setError(null);
    setBusy(true);
    const r = await counter.runBackup({ targetDir });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    setLastResult(r.data);
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <div className="text-lg font-semibold">Backup database</div>
        <div className="text-sm text-text-tertiary mt-1">
          Copies the live database to a folder you choose (insert a USB stick first).
          The backup is consistent — concurrent writes don't corrupt it. Take a fresh
          copy at the end of every day and rotate the USB stick off-site.
        </div>
      </div>

      {error && (
        <div className="border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}

      <div className="bg-bg-surface border border-border p-4 space-y-3">
        <div className="text-sm">
          <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Target folder</div>
          <div className="font-mono tnum text-text-tertiary break-all">
            {targetDir ?? '(none picked yet)'}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            disabled={!isOwner}
            onClick={() => void pick()}
            title={!isOwner ? 'OWNER role required' : ''}
            className={[
              'text-sm px-3 py-2 border',
              isOwner
                ? 'border-border hover:bg-bg-elevated'
                : 'border-border text-text-tertiary opacity-60 cursor-not-allowed',
            ].join(' ')}
          >
            Pick folder
          </button>
          <button
            disabled={!isOwner || !targetDir || busy}
            onClick={() => void run()}
            className="text-sm px-3 py-2 bg-accent text-bg-deep font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Backing up…' : 'Backup now'}
          </button>
        </div>
      </div>

      {lastResult && (
        <div className="bg-bg-surface border border-success/40 p-4 text-sm space-y-1">
          <div className="text-success font-semibold">Backup complete</div>
          <div className="text-text-tertiary">
            Wrote <span className="font-mono tnum text-text-primary">{(lastResult.sizeBytes / 1024).toFixed(1)} KB</span>
            {' '}to <span className="font-mono tnum text-text-primary break-all">{lastResult.targetPath}</span>
          </div>
          <div className="text-text-tertiary text-xs">
            {new Date(lastResult.timestampISO).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}
