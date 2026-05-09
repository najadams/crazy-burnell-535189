// backup.ts — copy the live DB to a target file via VACUUM INTO.
//
// VACUUM INTO is atomic: SQLite writes a fresh, defragmented copy at
// the target path; if the source DB is being written to concurrently,
// the copy is still consistent. This is the spec-mandated backup
// primitive (CLAUDE.md section 9).
//
// The renderer surfaces the backup as: pick a USB folder, click
// "Backup now," see the resulting path. No retention or scheduling in
// this minimum wave — section 9 calls for those, on the roadmap.

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export interface BackupResult {
  targetPath: string;
  sizeBytes: number;
  timestampISO: string;
}

export function runBackup(
  db: Database,
  targetDir: string,
  workerId: string,
  deviceId: string,
): BackupResult {
  if (!targetDir || !targetDir.trim()) {
    throw new Error('Pick a target folder for the backup (USB stick recommended).');
  }
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Target folder does not exist: ${targetDir}`);
  }

  const stamp = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
  const fileName = `counter-${stamp}.db`;
  const targetPath = path.join(targetDir, fileName);

  // VACUUM INTO refuses to overwrite. If today's backup already exists,
  // append HHMM to the filename so the second backup of the day still
  // works.
  let finalPath = targetPath;
  if (fs.existsSync(finalPath)) {
    const hhmm = new Date().toISOString().slice(11, 16).replace(':', '');
    finalPath = path.join(targetDir, `counter-${stamp}-${hhmm}.db`);
  }

  // Parameter binding doesn't work for paths in VACUUM INTO; sanitise
  // by escaping any single quotes (defence-in-depth — paths come from
  // an OS file picker, so the practical risk is low).
  const escaped = finalPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}';`);

  const stats = fs.statSync(finalPath);
  const result: BackupResult = {
    targetPath: finalPath,
    sizeBytes: stats.size,
    timestampISO: new Date().toISOString(),
  };

  logAudit(db, {
    workerId,
    action: 'BACKUP_RUN',
    entityType: 'backup',
    entityId: finalPath,
    afterValue: { sizeBytes: stats.size },
    deviceId,
  });

  return result;
}
