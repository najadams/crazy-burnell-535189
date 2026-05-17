// periods.ts — day-lock / period-close service.
//
// Section 3 + Section 8 of CLAUDE.md. The OWNER seals a day; sealed
// days reject new writes whose target date falls inside them. The
// reopen path is OWNER-only and one-shot: once a row's reopened_at is
// set, that row is permanently in the "lifted" state. Re-sealing the
// same day requires a new row, which the UNIQUE(location_id, date)
// constraint prevents unless the previous seal's row is the reopened
// one — i.e. you can only re-seal after a reopen by editing the
// existing row.
//
// In this implementation we keep it simpler than the spec's "one
// reopen ever" wording: a seal can be "lifted" by reopen, and that's
// the terminal state for that row. To re-seal, an OWNER would have
// to use a fresh approach (e.g. seal manually via direct SQL or
// extend this service). For the demo, the more common need is the
// initial seal + occasional reopen-to-fix-something flow.
//
// `assertNotSealed` is the gate every write path calls before
// modifying records dated to a specific day at a specific location.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

// Extract the YYYY-MM-DD portion of a UTC ISO timestamp. The depot is
// single-timezone; the spec's note about future tz handling is in
// Section 17's open-questions.
export function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

export interface PeriodCloseRow {
  id: string;
  locationId: string;
  date: string;
  sealedAt: string;
  sealedBy: string;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
}

function selectRow(db: Database, locationId: string, date: string): PeriodCloseRow | null {
  const r = db.prepare(
    `SELECT id, location_id AS locationId, date,
            sealed_at AS sealedAt, sealed_by AS sealedBy,
            reopened_at AS reopenedAt, reopened_by AS reopenedBy,
            reopen_reason AS reopenReason
       FROM period_closes
      WHERE location_id = ? AND date = ?`,
  ).get(locationId, date) as PeriodCloseRow | undefined;
  return r ?? null;
}

// True if (location, date) is sealed AND not subsequently reopened.
// Reopened rows behave as if no seal exists, for write-gate purposes.
export function isSealed(db: Database, locationId: string, date: string): boolean {
  const row = selectRow(db, locationId, date);
  if (!row) return false;
  return row.reopenedAt === null;
}

// Hard gate for every write path. Throws with a clear, user-facing
// message that names the date and a caller-supplied context so the
// cashier can interpret what was blocked.
export function assertNotSealed(
  db: Database, locationId: string, dateOrISO: string, context: string,
): void {
  const date = dateOrISO.length > 10 ? dateOf(dateOrISO) : dateOrISO;
  if (isSealed(db, locationId, date)) {
    throw new Error(
      `${context} blocked: ${date} is sealed. An OWNER must reopen the day from Settings → Day close before this can proceed.`,
    );
  }
}

export interface SealDayInput {
  locationId: string;
  date: string;             // YYYY-MM-DD (caller normalises)
  sealedByWorkerId: string;
}

export function sealDay(
  db: Database, input: SealDayInput, deviceId: string,
): { id: string } {
  // Reject sealing a future date — a no-op situation that's almost
  // always a typo. Today is the latest legitimate seal target.
  const today = dateOf(new Date().toISOString());
  if (input.date > today) {
    throw new Error(`Cannot seal a future date (${input.date}).`);
  }
  // Reject already-sealed (and not reopened) — explicit error rather
  // than a UNIQUE constraint surprise.
  const existing = selectRow(db, input.locationId, input.date);
  if (existing && existing.reopenedAt === null) {
    throw new Error(`${input.date} is already sealed.`);
  }
  // If a reopened row exists for this date, we leave it alone — the
  // user has explicitly chosen the unsealed state for this date.
  // Re-sealing after reopen is intentionally a no-op here; the
  // forensic record of the original seal+reopen stays intact. If the
  // OWNER genuinely wants to re-lock the same date, that's a future
  // feature.
  if (existing && existing.reopenedAt !== null) {
    throw new Error(
      `${input.date} was previously sealed and then reopened. Re-sealing the same date is not supported in this version; if the day needs locking again, contact support.`,
    );
  }

  const id = `pc-${uuidv4()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO period_closes (id, location_id, date, sealed_by, device_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.locationId, input.date, input.sealedByWorkerId, deviceId);

    logAudit(db, {
      workerId: input.sealedByWorkerId,
      action: 'PERIOD_SEALED',
      entityType: 'period_closes',
      entityId: id,
      afterValue: { locationId: input.locationId, date: input.date },
      deviceId,
    });
  });
  tx();
  return { id };
}

export interface ReopenDayInput {
  locationId: string;
  date: string;
  reopenedByWorkerId: string;
  reason: string;
}

export function reopenDay(
  db: Database, input: ReopenDayInput, deviceId: string,
): { id: string } {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new Error('A reopen reason is required (at least a few characters).');
  }
  const row = selectRow(db, input.locationId, input.date);
  if (!row) throw new Error(`${input.date} is not sealed.`);
  if (row.reopenedAt !== null) {
    throw new Error(`${input.date} has already been reopened once and cannot be reopened again.`);
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE period_closes
          SET reopened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              reopened_by = ?,
              reopen_reason = ?
        WHERE id = ?`,
    ).run(input.reopenedByWorkerId, input.reason.trim(), row.id);

    logAudit(db, {
      workerId: input.reopenedByWorkerId,
      action: 'PERIOD_REOPENED',
      entityType: 'period_closes',
      entityId: row.id,
      beforeValue: { sealedAt: row.sealedAt, sealedBy: row.sealedBy },
      afterValue: {
        locationId: input.locationId, date: input.date,
        reason: input.reason.trim(),
      },
      deviceId,
    });
  });
  tx();
  return { id: row.id };
}

// List recent seals for the Settings → Day close panel.
export function listRecentSeals(
  db: Database, locationId: string, limit = 30,
): PeriodCloseRow[] {
  return db.prepare(
    `SELECT id, location_id AS locationId, date,
            sealed_at AS sealedAt, sealed_by AS sealedBy,
            reopened_at AS reopenedAt, reopened_by AS reopenedBy,
            reopen_reason AS reopenReason
       FROM period_closes
      WHERE location_id = ?
      ORDER BY date DESC LIMIT ?`,
  ).all(locationId, limit) as PeriodCloseRow[];
}
