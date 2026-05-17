// BackupHealthBanner — surface backup freshness on HomeScreen.
//
// Spec Section 9. Reads <userData>/last_backup.json (via the
// BACKUP_GET_HEARTBEAT IPC channel) and shows a banner above the
// HomeScreen action grid when the off-site backup is stale or
// missing. Dismissible with "Remind tomorrow" — stored in
// localStorage at counter.backupBanner.dismissedUntil; expires at
// 06:00 next morning so the OWNER doesn't see the same banner
// hour after hour but does see it again first thing the next day.
//
// Severity tiers:
//   • ≤ 72 h since last backup     → banner hidden
//   • > 72 h and ≤ 7 days          → warning (amber)
//   • > 7 days                     → danger (red)
//   • no heartbeat ever on file    → danger (red), wording escalated
//
// Backups are the most important forensic protection the depot has;
// the banner is the only thing that makes the discipline visible.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';

const DISMISS_KEY = 'counter.backupBanner.dismissedUntil';

type Severity = 'hidden' | 'warning' | 'danger';

interface BannerState {
  severity: Severity;
  title: string;
  detail: string;
}

function compute(heartbeatISO: string | null): BannerState {
  if (!heartbeatISO) {
    return {
      severity: 'danger',
      title: 'No off-site backup on record yet.',
      detail: 'Plug in the USB stick and tap Backup in Settings → Backup. Without an off-site copy, a fire or theft loses everything.',
    };
  }
  const ageMs = Date.now() - new Date(heartbeatISO).getTime();
  if (Number.isNaN(ageMs)) {
    return { severity: 'hidden', title: '', detail: '' };
  }
  const hours = ageMs / (1000 * 60 * 60);
  if (hours <= 72) return { severity: 'hidden', title: '', detail: '' };
  const days = hours / 24;
  if (hours <= 24 * 7) {
    return {
      severity: 'warning',
      title: `Last off-site backup: ${formatAge(hours)} ago.`,
      detail: 'Run a backup soon — Settings → Backup. Off-site rotation is what keeps you safe from fire or theft.',
    };
  }
  return {
    severity: 'danger',
    title: `Last off-site backup: ${formatAge(hours)} ago — at risk.`,
    detail: 'A backup older than a week is not enough protection. Run a backup now from Settings → Backup.',
  };
}

function formatAge(hours: number): string {
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

// 6 AM next day so the OWNER opening the shop the morning after
// dismissing sees the reminder again.
function tomorrowAt6amISO(): string {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(6, 0, 0, 0);
  return t.toISOString();
}

function isCurrentlyDismissed(): boolean {
  try {
    const v = window.localStorage.getItem(DISMISS_KEY);
    if (!v) return false;
    return new Date(v).getTime() > Date.now();
  } catch {
    return false;
  }
}

export default function BackupHealthBanner(): JSX.Element | null {
  const [heartbeatISO, setHeartbeatISO] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => isCurrentlyDismissed());

  useEffect(() => {
    (async () => {
      const r = await counter.getBackupHeartbeat();
      if (r.success) setHeartbeatISO(r.data.heartbeat?.timestampISO ?? null);
      setLoaded(true);
    })();
  }, []);

  if (!loaded || dismissed) return null;

  const state = compute(heartbeatISO);
  if (state.severity === 'hidden') return null;

  function remindTomorrow() {
    try {
      window.localStorage.setItem(DISMISS_KEY, tomorrowAt6amISO());
    } catch {
      // localStorage may be unavailable in some Electron configs; the
      // banner just stays visible until the worker dismisses or
      // refreshes. Not fatal.
    }
    setDismissed(true);
  }

  const colourCls = state.severity === 'danger'
    ? 'border-danger bg-danger/10 text-danger'
    : 'border-warning bg-warning/10 text-warning';

  return (
    <div className={`border ${colourCls} px-4 py-3 rounded mb-4 flex items-start gap-4`}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{state.title}</div>
        <div className="text-xs mt-1 opacity-90">{state.detail}</div>
      </div>
      <button
        onClick={remindTomorrow}
        className="text-xs underline opacity-80 hover:opacity-100 whitespace-nowrap"
      >
        Remind tomorrow
      </button>
    </div>
  );
}
