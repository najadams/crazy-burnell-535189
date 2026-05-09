// auditQuery.ts — append-only audit log writer + simple read.
//
// Section 3 of CLAUDE.md: every state-changing service call writes one
// row. before_value / after_value are JSON-serialised. Never delete
// from this table.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';

export interface AuditEntry {
  workerId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeValue?: unknown;
  afterValue?: unknown;
  deviceId: string;
}

export function logAudit(db: Database, e: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log
       (id, worker_id, action, entity_type, entity_id,
        before_value, after_value, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `al-${uuidv4()}`,
    e.workerId, e.action, e.entityType, e.entityId,
    e.beforeValue !== undefined ? JSON.stringify(e.beforeValue) : null,
    e.afterValue  !== undefined ? JSON.stringify(e.afterValue)  : null,
    e.deviceId,
  );
}

export interface AuditQueryOptions {
  entityType?: string;
  entityId?: string;
  workerId?: string;
  action?: string;
  limit?: number;
}

export function queryAudit(db: Database, opts: AuditQueryOptions = {}): unknown[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.entityType) { where.push('entity_type = ?'); params.push(opts.entityType); }
  if (opts.entityId)   { where.push('entity_id = ?');   params.push(opts.entityId); }
  if (opts.workerId)   { where.push('worker_id = ?');   params.push(opts.workerId); }
  if (opts.action)     { where.push('action = ?');      params.push(opts.action); }
  const sql = `
    SELECT id, worker_id AS workerId, action, entity_type AS entityType,
           entity_id AS entityId, before_value AS beforeValue,
           after_value AS afterValue, created_at AS createdAt
      FROM audit_log
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC
     LIMIT ?`;
  params.push(opts.limit ?? 100);
  return db.prepare(sql).all(...params);
}
