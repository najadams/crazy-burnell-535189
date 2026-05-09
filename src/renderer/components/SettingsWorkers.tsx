// SettingsWorkers — minimum: show the current worker, button to change PIN.

import { useState } from 'react';
import { useSession } from '../store/session';
import ChangePinModal from './ChangePinModal';

export default function SettingsWorkers(): JSX.Element {
  const fullName = useSession((s) => s.fullName);
  const role = useSession((s) => s.workerRole);
  const [showChange, setShowChange] = useState(false);

  return (
    <div className="space-y-4">
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

      {showChange && (
        <ChangePinModal
          onClose={() => setShowChange(false)}
          onChanged={() => setShowChange(false)}
        />
      )}
    </div>
  );
}
