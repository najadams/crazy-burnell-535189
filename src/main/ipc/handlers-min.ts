// handlers-min.ts — IPC handlers for the minimum-shippable wave:
// stock receive / on-hand, void sale, cash drop, change PIN,
// add product, add customer, backup. Mirrors the Wave H handler-
// group pattern: a registerMinHandlers() called from main/index.ts.
//
// Auth gating:
//   - Reads (stockOnHand) → any worker.
//   - Writes (receive, void, drop, changePin, createProduct,
//     createCustomer, runBackup) → OWNER-or-FOUNDER. The visible-
//     but-disabled UI pattern (Section 11) lives at the call site.

import type { IpcMain, BrowserWindow } from 'electron';
import type { Database } from 'better-sqlite3';
import { dialog } from 'electron';

import {
  IPC_CHANNELS_STOCK, IPC_CHANNELS_VOIDS, IPC_CHANNELS_CASH,
  IPC_CHANNELS_ADMIN, IPC_CHANNELS_BACKUP,
} from '../../shared/types/ipc.js';
import type {
  StockReceiveRequest, StockReceiveResponse,
  StockOnHandRequest, StockOnHandResponse,
  VoidSaleRequest, VoidSaleResponse,
  CashDropRecordRequest, CashDropRecordResponse,
  WorkerChangePinRequest, WorkerChangePinResponse,
  ProductCreateRequest, ProductCreateResponse,
  CustomerCreateRequest, CustomerCreateResponse,
  BackupPickDirResponse, BackupRunRequest, BackupRunResponse,
  BackupHeartbeatResponse,
  SessionInfo,
} from '../../shared/types/ipc.js';

import { recordReceipt } from '../services/stockReceipts.js';
import { stockOnHand } from '../services/stockHistory.js';
import { voidSale } from '../services/voids.js';
import { recordCashDrop } from '../services/cashDrops.js';
import { changePin } from '../services/workersAdmin.js';
import { createProduct } from '../services/productsAdmin.js';
import { createCustomer } from '../services/customersAdmin.js';
import { runBackup, writeBackupHeartbeat, readBackupHeartbeat } from '../services/backup.js';
import { app } from 'electron';

interface Helpers {
  wrap: <Req, Res>(
    fn: (req: Req) => Res | Promise<Res>,
    channel: string,
  ) => (event: unknown, req: Req) => Promise<{ success: true; data: Res } | { success: false; error: string }>;
  requireWorker: () => SessionInfo;
  requireOwnerLike: () => SessionInfo;
}

interface OpenShiftRow { shiftId: string; locationId: string }

function openShiftFor(db: Database, workerId: string): OpenShiftRow {
  const row = db.prepare(
    `SELECT id AS shiftId, location_id AS locationId
       FROM shifts
      WHERE worker_id = ? AND closed_at IS NULL
      ORDER BY opened_at DESC LIMIT 1`,
  ).get(workerId) as OpenShiftRow | undefined;
  if (!row) throw new Error('Open a shift before completing this action.');
  return row;
}

export function registerMinHandlers(
  ipcMain: IpcMain,
  db: Database,
  deviceId: string,
  helpers: Helpers,
  getMainWindow: () => BrowserWindow | null,
): void {
  const { wrap, requireWorker, requireOwnerLike } = helpers;

  // ---- Stock ----

  ipcMain.handle(IPC_CHANNELS_STOCK.STOCK_RECEIVE,
    wrap<StockReceiveRequest, StockReceiveResponse>(
      (req) => {
        // Receiving is OWNER-only for the demo (single-user shop).
        // In production, SUPERVISOR should be able to receive too.
        const w = requireOwnerLike();
        const open = (() => {
          // Receiving doesn't require a shift — receipts can happen
          // outside shop hours. Try to attach to the open shift if
          // there is one; otherwise ship without a shift_id.
          try {
            return openShiftFor(db, w.workerId);
          } catch {
            return { shiftId: null as string | null, locationId: '' };
          }
        })();
        // If no shift, we still need a location id. Resolve the only
        // active location.
        let locationId = open.locationId;
        if (!locationId) {
          const loc = db.prepare(
            `SELECT id FROM locations WHERE active = 1
              ORDER BY created_at ASC LIMIT 1`,
          ).get() as { id: string } | undefined;
          if (!loc) throw new Error('No active location configured.');
          locationId = loc.id;
        }
        return recordReceipt(db, {
          workerId: w.workerId,
          locationId,
          shiftId: open.shiftId,
          supplierId: req.supplierId ?? null,
          lines: req.lines,
          notes: req.notes,
        }, deviceId);
      },
      IPC_CHANNELS_STOCK.STOCK_RECEIVE,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_STOCK.STOCK_ON_HAND,
    wrap<StockOnHandRequest, StockOnHandResponse>(
      (req) => {
        requireWorker();
        return { rows: stockOnHand(db, req?.locationId) };
      },
      IPC_CHANNELS_STOCK.STOCK_ON_HAND,
    ),
  );

  // ---- Voids ----

  ipcMain.handle(IPC_CHANNELS_VOIDS.VOID_SALE,
    wrap<VoidSaleRequest, VoidSaleResponse>(
      (req) => {
        const w = requireOwnerLike();
        return voidSale(db, req.saleId, w.workerId, req.reason, deviceId);
      },
      IPC_CHANNELS_VOIDS.VOID_SALE,
    ),
  );

  // ---- Cash drops ----

  ipcMain.handle(IPC_CHANNELS_CASH.CASH_DROP_RECORD,
    wrap<CashDropRecordRequest, CashDropRecordResponse>(
      (req) => {
        const w = requireWorker();
        const open = openShiftFor(db, w.workerId);
        return recordCashDrop(
          db, open.shiftId, w.workerId,
          req.amountPesewas, req.reason, req.note, deviceId,
        );
      },
      IPC_CHANNELS_CASH.CASH_DROP_RECORD,
    ),
  );

  // ---- Admin: workers / products / customers ----

  ipcMain.handle(IPC_CHANNELS_ADMIN.WORKER_CHANGE_PIN,
    wrap<WorkerChangePinRequest, WorkerChangePinResponse>(
      (req) => {
        const w = requireWorker();         // any worker can change THEIR own PIN
        return changePin(db, w.workerId, req.oldPin, req.newPin, deviceId);
      },
      IPC_CHANNELS_ADMIN.WORKER_CHANGE_PIN,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_ADMIN.PRODUCT_CREATE,
    wrap<ProductCreateRequest, ProductCreateResponse>(
      (req) => {
        const w = requireOwnerLike();
        return createProduct(db, req, w.workerId, deviceId);
      },
      IPC_CHANNELS_ADMIN.PRODUCT_CREATE,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_ADMIN.CUSTOMER_CREATE,
    wrap<CustomerCreateRequest, CustomerCreateResponse>(
      (req) => {
        const w = requireOwnerLike();
        return createCustomer(db, req, w.workerId, deviceId);
      },
      IPC_CHANNELS_ADMIN.CUSTOMER_CREATE,
    ),
  );

  // ---- Backup ----

  ipcMain.handle(IPC_CHANNELS_BACKUP.BACKUP_PICK_DIR,
    wrap<{}, BackupPickDirResponse>(
      async () => {
        requireOwnerLike();
        const win = getMainWindow();
        const result = await dialog.showOpenDialog(win!, {
          title: 'Pick a folder for the backup (USB stick recommended)',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { path: null };
        }
        return { path: result.filePaths[0]! };
      },
      IPC_CHANNELS_BACKUP.BACKUP_PICK_DIR,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_BACKUP.BACKUP_RUN,
    wrap<BackupRunRequest, BackupRunResponse>(
      (req) => {
        const w = requireOwnerLike();
        const result = runBackup(db, req.targetDir, w.workerId, deviceId);
        // Write the heartbeat so the HomeScreen banner can see how
        // long ago the last backup ran. Failures here are non-fatal —
        // logged inside the service, but they don't fail the IPC call.
        writeBackupHeartbeat(app.getPath('userData'), {
          timestampISO: result.timestampISO,
          targetPath: result.targetPath,
          sizeBytes: result.sizeBytes,
        });
        return result;
      },
      IPC_CHANNELS_BACKUP.BACKUP_RUN,
    ),
  );

  // Heartbeat read for the HomeScreen banner. Returns null if no
  // backup has ever run (the banner shows the "no heartbeat" state
  // for that case).
  ipcMain.handle(IPC_CHANNELS_BACKUP.BACKUP_GET_HEARTBEAT,
    wrap<{}, BackupHeartbeatResponse>(
      () => {
        requireWorker();
        const hb = readBackupHeartbeat(app.getPath('userData'));
        return { heartbeat: hb };
      },
      IPC_CHANNELS_BACKUP.BACKUP_GET_HEARTBEAT,
    ),
  );
}
