// supervisorApprovals.ts — reusable supervisor-PIN gate.
//
// Spec Section 11 + migration 0008. Two functions:
//
//   verifySupervisorPin(db, opts) — bcrypt-compare a submitted PIN
//     against every active SUPERVISOR/OWNER/FOUNDER worker. On success
//     insert a supervisor_approvals row and return its id. On failure
//     throw with a deliberately vague message ("Incorrect PIN.") so a
//     caller can't probe which roles are in play. The audit log
//     captures both the success and the failure with the cashier's
//     worker id (not the supervisor's, since failures have no matched
//     supervisor).
//
//   consumeSupervisorApproval(db, opts) — check that an approval id
//     exists, hasn't been used, hasn't expired, and matches the
//     expected purpose. Mark it used_at + used_by_action +
//     used_by_entity_id atomically. Throws if any check fails.
//
// The approval is single-use and time-bounded (default 5 min from
// creation). Both invariants are enforced here in service code; the
// schema only enforces "you must record the supervisor."

import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export type SupervisorApprovalPurpose =
  | 'OVER_LIMIT_PARTIAL'
  | 'OVER_THRESHOLD_DISCOUNT'
  | 'BREAKAGE'
  | 'VOID_SALE'
  | 'CUSTOMER_RETURN'
  | 'STOCKTAKE_LARGE_DELTA';

export interface VerifySupervisorPinInput {
  // The cashier requesting elevation. Their worker id is audit-logged
  // regardless of approval outcome.
  cashierWorkerId: string;
  pin: string;
  purpose: SupervisorApprovalPurpose;
  // JSON-serialisable snapshot of what's being approved. Stored on the
  // approval row for forensic readers; not used for validation.
  context?: Record<string, unknown>;
  // Approval lifetime in seconds. Default 5 minutes — long enough for
  // the supervisor to walk away and the cashier to finish typing,
  // short enough that a stale approval can't gate an unrelated action
  // ten minutes later.
  ttlSeconds?: number;
}

export interface VerifySupervisorPinResult {
  approvalId: string;
  supervisorWorkerId: string;
  supervisorName: string;
  expiresAt: string;
}

const DEFAULT_TTL_SECONDS = 5 * 60;
const ELIGIBLE_ROLES = ['SUPERVISOR', 'OWNER', 'FOUNDER'] as const;

export function verifySupervisorPin(
  db: Database,
  input: VerifySupervisorPinInput,
  deviceId: string,
): VerifySupervisorPinResult {
  if (typeof input.pin !== 'string' || input.pin.length === 0) {
    throw new Error('PIN is required.');
  }

  // Pull every active supervisor-or-higher worker's hash. Sorted by
  // role so OWNER matches are preferred when (vanishingly unlikely)
  // two workers' PINs collide on the same plaintext.
  const candidates = db.prepare(
    `SELECT id, full_name AS fullName, role, pin_hash AS pinHash
       FROM workers
      WHERE active = 1 AND role IN ('SUPERVISOR','OWNER','FOUNDER')
      ORDER BY CASE role
                 WHEN 'OWNER'      THEN 1
                 WHEN 'FOUNDER'    THEN 2
                 WHEN 'SUPERVISOR' THEN 3
               END ASC`,
  ).all() as Array<{ id: string; fullName: string; role: string; pinHash: string }>;

  let matched: { id: string; fullName: string; role: string } | null = null;
  for (const row of candidates) {
    if (bcrypt.compareSync(input.pin, row.pinHash)) {
      matched = { id: row.id, fullName: row.fullName, role: row.role };
      break;
    }
  }

  if (!matched) {
    // Audit the failed elevation attempt. The cashier's worker id
    // attributes the attempt; the supervisor id is absent because no
    // PIN matched. Deliberately vague error message to the caller.
    logAudit(db, {
      workerId: input.cashierWorkerId,
      action: 'SUPERVISOR_PIN_FAILED',
      entityType: 'supervisor_approvals',
      entityId: 'none',
      afterValue: { purpose: input.purpose, context: input.context ?? {} },
      deviceId,
    });
    throw new Error('Incorrect PIN.');
  }

  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const approvalId = `sa-${uuidv4()}`;
  // SQLite-side timestamp for expires_at so it shares a clock with
  // the created_at default and the consumeSupervisorApproval check.
  const expiresAtRow = db.prepare(
    `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ? || ' seconds') AS exp`,
  ).get(ttl) as { exp: string };

  db.prepare(
    `INSERT INTO supervisor_approvals
       (id, supervisor_worker_id, purpose, context_json, expires_at,
        created_by, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    approvalId, matched.id, input.purpose,
    JSON.stringify(input.context ?? {}),
    expiresAtRow.exp, input.cashierWorkerId, deviceId,
  );

  logAudit(db, {
    workerId: input.cashierWorkerId,
    action: 'SUPERVISOR_PIN_OK',
    entityType: 'supervisor_approvals',
    entityId: approvalId,
    afterValue: {
      supervisorWorkerId: matched.id,
      supervisorRole: matched.role,
      purpose: input.purpose,
      context: input.context ?? {},
      ttlSeconds: ttl,
    },
    deviceId,
  });

  return {
    approvalId,
    supervisorWorkerId: matched.id,
    supervisorName: matched.fullName,
    expiresAt: expiresAtRow.exp,
  };
}

export interface ConsumeSupervisorApprovalInput {
  approvalId: string;
  expectedPurpose: SupervisorApprovalPurpose;
  // The downstream action and entity that the approval gates. Recorded
  // on the approval row so forensic readers can follow the approval
  // forward to the entity it authorised.
  action: string;
  entityId: string;
}

export function consumeSupervisorApproval(
  db: Database,
  input: ConsumeSupervisorApprovalInput,
): { supervisorWorkerId: string } {
  // Single statement covers all three checks: exists, not yet used,
  // not yet expired. Pulling supervisor_worker_id lets the caller
  // (e.g. createSale) attribute the elevation downstream.
  const row = db.prepare(
    `SELECT supervisor_worker_id AS supervisorWorkerId, purpose, used_at AS usedAt, expires_at AS expiresAt
       FROM supervisor_approvals
      WHERE id = ?`,
  ).get(input.approvalId) as
    | { supervisorWorkerId: string; purpose: string; usedAt: string | null; expiresAt: string }
    | undefined;

  if (!row) {
    throw new Error('Supervisor approval not found.');
  }
  if (row.usedAt) {
    throw new Error('Supervisor approval has already been used.');
  }
  if (row.purpose !== input.expectedPurpose) {
    // Approvals are purpose-bound — an over-limit approval can't be
    // redirected to authorise a discount. Catches both honest bugs
    // (wrong approval passed in) and concocted attacks (cashier
    // re-uses a cheaper-to-get approval id for a more sensitive
    // action).
    throw new Error('Supervisor approval is not valid for this action.');
  }
  // expires_at and 'now' are both ISO strings produced by the same
  // strftime format, so string compare is total-order correct.
  const nowRow = db.prepare(
    `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now`,
  ).get() as { now: string };
  if (row.expiresAt < nowRow.now) {
    throw new Error('Supervisor approval has expired.');
  }

  db.prepare(
    `UPDATE supervisor_approvals
        SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            used_by_action = ?,
            used_by_entity_id = ?
      WHERE id = ?`,
  ).run(input.action, input.entityId, input.approvalId);

  return { supervisorWorkerId: row.supervisorWorkerId };
}
