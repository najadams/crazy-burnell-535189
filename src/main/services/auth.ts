// auth.ts — PIN-based login.
//
// Workers pick themselves from a list, then enter a PIN. PIN is bcrypt-
// compared. Spec section 11 names rate-limiting (`pin_attempts` table,
// migration 0011) — out of scope for this scaffold. The demo runs on
// the depot owner's machine, so the threat model is "stop a curious
// helper from logging in," not "withstand sustained brute force."

import bcrypt from 'bcryptjs';
import type { Database } from 'better-sqlite3';
import type { SessionInfo, WorkerSummary, WorkerRole } from '../../shared/types/ipc.js';

export function listWorkers(db: Database): WorkerSummary[] {
  const rows = db.prepare(
    `SELECT id, full_name AS fullName, role
       FROM workers WHERE active = 1
       ORDER BY CASE role
                  WHEN 'OWNER'      THEN 1
                  WHEN 'FOUNDER'    THEN 2
                  WHEN 'SUPERVISOR' THEN 3
                  WHEN 'CASHIER'    THEN 4
                  ELSE 5
                END,
                full_name ASC`,
  ).all() as Array<{ id: string; fullName: string; role: WorkerRole }>;
  return rows;
}

export function login(db: Database, workerId: string, pin: string): SessionInfo {
  const row = db.prepare(
    `SELECT id, full_name AS fullName, role, pin_hash AS pinHash
       FROM workers WHERE id = ? AND active = 1`,
  ).get(workerId) as
    | { id: string; fullName: string; role: WorkerRole; pinHash: string }
    | undefined;
  if (!row) throw new Error('Worker not found or inactive.');

  const ok = bcrypt.compareSync(pin, row.pinHash);
  if (!ok) throw new Error('Incorrect PIN.');

  return { workerId: row.id, fullName: row.fullName, role: row.role };
}
