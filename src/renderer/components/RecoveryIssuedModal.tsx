// RecoveryIssuedModal — shows a freshly-issued recovery code ONCE.
//
// The plaintext code is shown in a copyable monospace block alongside
// a "I have written this down somewhere safe" checkbox; the close
// button is disabled until the checkbox is ticked. This is the only
// time the code will be displayed — if the user dismisses without
// recording it, the only way back is for an OWNER to regenerate from
// Settings (and the old code dies at that point too).
//
// Used by:
//   - LoginScreen recovery flow (returned plaintext after reset)
//   - Settings → Workers "Regenerate recovery code" button

import { useState } from 'react';

interface Props {
  code: string;
  // Free-text rationale displayed above the code so the user knows
  // why they're seeing it. Example: "PIN reset successful. New
  // recovery code:" or "Recovery code regenerated for OWNER Naj."
  intro: string;
  onClose: () => void;
}

export default function RecoveryIssuedModal({
  code, intro, onClose,
}: Props): JSX.Element {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface border border-warning rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-border">
          <div className="text-lg font-semibold">Recovery code</div>
          <div className="text-xs text-text-tertiary mt-1">
            Shown once. After you close this dialog, the only way to see
            this code again is to regenerate it — which will replace it
            with a new one.
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="text-sm text-text-secondary">{intro}</div>

          <div className="bg-bg-deep border border-warning rounded p-4">
            <div className="font-mono tnum text-center text-2xl tracking-[0.15em]">
              {code}
            </div>
          </div>

          <ol className="text-xs text-text-tertiary space-y-1 list-decimal pl-5">
            <li>Write this code down on paper.</li>
            <li>Store it somewhere only the OWNER can reach (a locked drawer or a wallet).</li>
            <li>Do not photograph it on a phone that other people use.</li>
          </ol>

          <label className="flex items-start gap-2 text-sm cursor-pointer pt-2">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1"
              autoFocus
            />
            <span>I have written this code down somewhere safe.</span>
          </label>

          <div className="flex justify-end pt-2">
            <button
              onClick={onClose}
              disabled={!confirmed}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              I'm done — close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
