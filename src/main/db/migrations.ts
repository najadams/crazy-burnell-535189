// migrations.ts — sequential, transactional migration runner.
//
// Reads every .sql file in the migrations directory, sorts by filename
// (which is also the version), and applies any not yet recorded in
// `_migrations`. Each migration runs inside its own transaction so a
// crash mid-migration leaves the DB in a valid pre-migration state.

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

export function runMigrations(db: Database, dir: string): { applied: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const applied = new Set(
    db.prepare(`SELECT version FROM _migrations`).all().map((r: any) => r.version),
  );

  if (!fs.existsSync(dir)) {
    throw new Error(`runMigrations: directory ${dir} does not exist`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const newlyApplied: string[] = [];
  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO _migrations (version) VALUES (?)`).run(version);
    });
    tx();
    newlyApplied.push(version);
  }

  return { applied: newlyApplied };
}
