// workersAdmin.ts — minimum-viable worker admin for the demo wave.
// Just changePin for now. Adding workers / deactivating workers is
// straightforward but not on the critical path (single-user shop until
// dad hires a helper).

import bcrypt from 'bcryptjs';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export function changePin(
  db: Database,
  workerId: string,
  oldPin: string,
  newPin: string,
  deviceId: string,
): { ok: true } {
  if (newPin.length < 4) {
    throw new Error('PIN must be at least 4 digits.');
  }
  if (oldPin === newPin) {
    throw new Error('New PIN must be different from old PIN.');
  }
  const row = db.prepare(
    `SELECT pin_hash AS pinHash FROM workers WHERE id = ? AND active = 1`,
  ).get(workerId) as { pinHash: string } | undefined;
  if (!row) throw new Error('Worker not found.');

  if (!bcrypt.compareSync(oldPin, row.pinHash)) {
    throw new Error('Current PIN is incorrect.');
  }

  const newHash = bcrypt.hashSync(newPin, 12);
  db.prepare(
    `UPDATE workers
        SET pin_hash = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_by = ?
      WHERE id = ?`,
  ).run(newHash, workerId, workerId);

  logAudit(db, {
    workerId,
    action: 'WORKER_PIN_CHANGED',
    entityType: 'workers',
    entityId: workerId,
    afterValue: { pinChangedAt: new Date().toISOString() },
    deviceId,
  });

  return { ok: true };
}
