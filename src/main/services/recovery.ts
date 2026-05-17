// recovery.ts — OWNER PIN recovery. Spec Section 10.
//
// The OWNER (or FOUNDER) gets a 16-character recovery code at first
// issuance, formatted XXXX-XXXX-XXXX-XXXX. The plaintext is shown
// ONCE — only the bcrypt-12 hash is persisted on workers. If the
// OWNER forgets their PIN, the LoginScreen "Forgot PIN" flow asks for
// the recovery code, compares it (hyphens/case stripped) against the
// stored hash, and on success lets the user set a new PIN. The act of
// using the code rotates it: a fresh recovery code is generated and
// returned, the old hash is overwritten, and the old code dies.
//
// The "Regenerate recovery code" button in Settings → Workers calls
// the same generate path; same rotation rule applies.
//
// Alphabet excludes O, 0, I, 1 (visually confusing on paper). Chosen
// over the spec's "alphanumerics" wording because the recovery code
// is written by a human under stress and read back later.
//
// Recovery codes are only issued for OWNER and FOUNDER roles. Lower
// roles get a PIN reset by an OWNER through Settings (not yet built;
// out of scope for this pass).

import bcrypt from 'bcryptjs';
import { randomFillSync } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars
const CODE_LENGTH = 16;
const HASH_ROUNDS = 12;
const ELIGIBLE_ROLES = ['OWNER', 'FOUNDER'] as const;

// Generate the plaintext recovery code. 16 alphanumerics with the
// visually-confusing characters (O, 0, I, 1) removed, formatted with
// hyphens at group boundaries for legibility.
function generatePlaintextCode(): string {
  const buf = new Uint32Array(CODE_LENGTH);
  randomFillSync(buf);
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += ALPHABET[buf[i] % ALPHABET.length];
  }
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

// Normalise a user-typed code before comparison — they might type it
// without hyphens, in lowercase, or with stray spaces. Compare on the
// 16-char canonical uppercase form.
function normalise(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

// Generate (or rotate) the recovery code for a worker. Caller must
// already have permission to act on this worker (the IPC layer is
// where OWNER-only gating happens for regenerate; the reset path
// passes the target worker id from the unauthenticated
// verifyRecoveryCodeAndResetPin handler).
export function generateRecoveryCode(
  db: Database,
  input: { targetWorkerId: string; issuedByWorkerId: string },
  deviceId: string,
): { code: string } {
  const target = db.prepare(
    `SELECT id, role FROM workers WHERE id = ? AND active = 1`,
  ).get(input.targetWorkerId) as { id: string; role: string } | undefined;
  if (!target) throw new Error('Worker not found.');
  if (!(ELIGIBLE_ROLES as readonly string[]).includes(target.role)) {
    throw new Error('Recovery codes are only issued for OWNER or FOUNDER workers.');
  }
  // Issuer must also exist (audit attribution requires a real FK).
  const issuer = db.prepare(
    `SELECT id FROM workers WHERE id = ?`,
  ).get(input.issuedByWorkerId) as { id: string } | undefined;
  if (!issuer) throw new Error('Issuing worker not found.');

  const plaintext = generatePlaintextCode();
  const hash = bcrypt.hashSync(normalise(plaintext), HASH_ROUNDS);

  db.prepare(
    `UPDATE workers
        SET recovery_code_hash = ?,
            recovery_code_issued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            recovery_code_issued_by = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_by = ?
      WHERE id = ?`,
  ).run(hash, input.issuedByWorkerId, input.issuedByWorkerId, input.targetWorkerId);

  logAudit(db, {
    workerId: input.issuedByWorkerId,
    action: 'RECOVERY_CODE_ISSUED',
    entityType: 'workers',
    entityId: input.targetWorkerId,
    afterValue: { targetRole: target.role },
    deviceId,
  });

  return { code: plaintext };
}

// Verify a submitted recovery code against the stored hash for the
// target worker. On success: rotate the code (old hash dies, new
// plaintext returned) AND set the new PIN. Audit captures the reset.
// On failure: throw "Recovery code does not match." — deliberately
// vague to avoid leaking which workers have codes on file.
//
// Single-use is enforced by the rotation: the old hash is overwritten
// inside the same transaction as the PIN set, so the same plaintext
// can't be replayed.
export function verifyRecoveryCodeAndResetPin(
  db: Database,
  input: { targetWorkerId: string; submittedCode: string; newPin: string },
  deviceId: string,
): { newRecoveryCode: string } {
  if (typeof input.newPin !== 'string' || input.newPin.length < 4) {
    throw new Error('New PIN must be at least 4 digits.');
  }
  if (typeof input.submittedCode !== 'string' || input.submittedCode.trim().length === 0) {
    throw new Error('Recovery code is required.');
  }
  const target = db.prepare(
    `SELECT id, role, recovery_code_hash AS recoveryHash
       FROM workers WHERE id = ? AND active = 1`,
  ).get(input.targetWorkerId) as
    | { id: string; role: string; recoveryHash: string | null }
    | undefined;
  if (!target) throw new Error('Worker not found.');
  if (!(ELIGIBLE_ROLES as readonly string[]).includes(target.role)) {
    throw new Error('Recovery flow is only available for OWNER or FOUNDER workers.');
  }
  if (!target.recoveryHash) {
    // No code on file means recovery isn't possible. Surface a
    // clear error rather than a generic "does not match" — the
    // OWNER would otherwise burn attempts on a code that can't
    // succeed.
    throw new Error('No recovery code on file. The OWNER must regenerate from Settings.');
  }
  const ok = bcrypt.compareSync(normalise(input.submittedCode), target.recoveryHash);
  if (!ok) throw new Error('Recovery code does not match.');

  const newPinHash = bcrypt.hashSync(input.newPin, HASH_ROUNDS);
  const newRecoveryCode = generatePlaintextCode();
  const newRecoveryHash = bcrypt.hashSync(normalise(newRecoveryCode), HASH_ROUNDS);

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE workers
          SET pin_hash = ?,
              recovery_code_hash = ?,
              recovery_code_issued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              recovery_code_issued_by = id,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = id
        WHERE id = ?`,
    ).run(newPinHash, newRecoveryHash, input.targetWorkerId);

    logAudit(db, {
      // Self-attributed because this flow is unauthenticated; the
      // caller hasn't logged in yet. The audit row says "this worker's
      // PIN was reset via recovery code at time T."
      workerId: input.targetWorkerId,
      action: 'OWNER_PIN_RESET',
      entityType: 'workers',
      entityId: input.targetWorkerId,
      afterValue: { targetRole: target.role, viaRecoveryCode: true },
      deviceId,
    });
  });
  tx();

  return { newRecoveryCode };
}

// Pre-login affordance: the LoginScreen "Forgot PIN" flow needs to
// show a picker of OWNER/FOUNDER workers. This is unauthenticated by
// design (the user is locked out and can't pick from the normal
// login list because they don't know their PIN). We expose only the
// minimum: id, name, role, and whether a recovery code is on file.
export function listRecoveryEligibleWorkers(db: Database): Array<{
  id: string; fullName: string; role: string; hasRecoveryCode: boolean;
}> {
  const rows = db.prepare(
    `SELECT id, full_name AS fullName, role,
            recovery_code_hash IS NOT NULL AS hasRecoveryCode
       FROM workers
      WHERE active = 1 AND role IN ('OWNER','FOUNDER')
      ORDER BY full_name ASC`,
  ).all() as Array<{ id: string; fullName: string; role: string; hasRecoveryCode: number }>;
  return rows.map((r) => ({ ...r, hasRecoveryCode: !!r.hasRecoveryCode }));
}
