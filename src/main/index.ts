// index.ts — Electron main process entry.
//
// Boot sequence:
//   1. app.whenReady()
//   2. Open SQLite at <userData>/counter.db (better-sqlite3, WAL).
//   3. Run migrations from the bundled migrations/ folder.
//   4. Seed default OWNER / location / products / customers / loyalty.
//   5. Register all IPC handlers (core + Wave H).
//   6. Open BrowserWindow, load the renderer.

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';

// bcryptjs auto-detects WebCryptoAPI / Node crypto, but the Electron main
// ESM bundle leaves neither directly visible to it. Wire node:crypto in
// explicitly so bcrypt.hashSync works during seed and PIN flows.
bcrypt.setRandomFallback((len) => Array.from(randomBytes(len)));

import { runMigrations } from './db/migrations.js';
import { ensureDefaults, DEMO_PIN_FOR_HUMANS } from './db/seed.js';
import {
  registerCoreHandlers, requireWorker, requireOwnerLike, wrap,
} from './ipc/handlers.js';
import { registerWaveHHandlers } from './ipc/handlers-wave-h.js';
import { registerMinHandlers } from './ipc/handlers-min.js';
import { registerPaymentHandlers } from './ipc/handlers-payments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DEVICE_ID = 'd-counter-1';

// Vite-plugin-electron sets this env var when the dev server is running.
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// In dev, migrations/ sits at the project root next to package.json.
// In a packaged app, electron-builder ships migrations/ as an
// extraResource (see electron-builder.yml) and process.resourcesPath
// points to the resources folder.
function resolveMigrationsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'migrations');
  }
  // dist-electron/main.js → ../../migrations
  return path.resolve(__dirname, '..', 'migrations');
}

function openDb(): Database.Database {
  const dbPath = path.join(app.getPath('userData'), 'counter.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0f14',
    title: 'Counter',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  const db = openDb();

  const migrationsDir = resolveMigrationsDir();
  const { applied } = runMigrations(db, migrationsDir);
  if (applied.length > 0) {
    console.log(`[migrations] applied: ${applied.join(', ')}`);
  }

  const seedResult = ensureDefaults(db, DEVICE_ID);
  if (seedResult.seeded) {
    console.log(
      `[seed] first-run defaults installed.\n` +
      `[seed] OWNER: Naj — PIN ${DEMO_PIN_FOR_HUMANS}\n` +
      `[seed] You can change the PIN from the future Settings → Workers tab.`,
    );
  }

  registerCoreHandlers(ipcMain, db, DEVICE_ID);
  registerWaveHHandlers(ipcMain, db, DEVICE_ID, {
    wrap, requireWorker, requireOwnerLike,
  });
  registerMinHandlers(ipcMain, db, DEVICE_ID,
    { wrap, requireWorker, requireOwnerLike },
    () => mainWindow,
  );
  registerPaymentHandlers(ipcMain, db, DEVICE_ID, { wrap, requireWorker });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Standard mac convention: stay running until cmd+Q. Counter is a
  // single-machine workhorse; on Windows / Linux we quit on close.
  if (process.platform !== 'darwin') app.quit();
});
