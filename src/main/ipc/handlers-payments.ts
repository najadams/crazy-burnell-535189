// handlers-payments.ts — IPC for customer payments + sale detail.
// Mirrors the per-wave handler-group pattern.

import type { IpcMain } from 'electron';
import type { Database } from 'better-sqlite3';

import {
  IPC_CHANNELS_PAYMENTS, IPC_CHANNELS_SALE_DETAIL,
} from '../../shared/types/ipc.js';
import type {
  RecordPaymentRequest, RecordPaymentResponse,
  OpenCreditSalesRequest, OpenCreditSalesResponse,
  PaymentsListRequest, PaymentsListResponse,
  SaleGetByIdRequest, SaleGetByIdResponse,
  SessionInfo,
} from '../../shared/types/ipc.js';

import {
  recordCustomerPayment, openCreditSalesForCustomer,
  listPaymentsForCustomer,
} from '../services/customerPayments.js';
import { getSaleById } from '../services/salesQuery.js';

interface Helpers {
  wrap: <Req, Res>(
    fn: (req: Req) => Res | Promise<Res>,
    channel: string,
  ) => (event: unknown, req: Req) => Promise<{ success: true; data: Res } | { success: false; error: string }>;
  requireWorker: () => SessionInfo;
}

export function registerPaymentHandlers(
  ipcMain: IpcMain, db: Database, deviceId: string, helpers: Helpers,
): void {
  const { wrap, requireWorker } = helpers;

  ipcMain.handle(IPC_CHANNELS_PAYMENTS.CUSTOMER_RECORD_PAYMENT,
    wrap<RecordPaymentRequest, RecordPaymentResponse>(
      (req) => {
        const w = requireWorker();
        // Attach to the open shift only when payment_method = CASH —
        // closing-cash math relies on this.
        let shiftId: string | null = null;
        if (req.paymentMethod === 'CASH') {
          const row = db.prepare(
            `SELECT id FROM shifts
              WHERE worker_id = ? AND closed_at IS NULL
              ORDER BY opened_at DESC LIMIT 1`,
          ).get(w.workerId) as { id: string } | undefined;
          if (!row) {
            throw new Error('Open a shift before recording a cash payment.');
          }
          shiftId = row.id;
        }
        return recordCustomerPayment(db, {
          customerId: req.customerId,
          shiftId,
          amountPesewas: req.amountPesewas,
          paymentMethod: req.paymentMethod,
          paymentReference: req.paymentReference,
          notes: req.notes,
        }, w.workerId, deviceId);
      },
      IPC_CHANNELS_PAYMENTS.CUSTOMER_RECORD_PAYMENT,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_PAYMENTS.CUSTOMER_OPEN_CREDIT,
    wrap<OpenCreditSalesRequest, OpenCreditSalesResponse>(
      (req) => {
        requireWorker();
        return { sales: openCreditSalesForCustomer(db, req.customerId) };
      },
      IPC_CHANNELS_PAYMENTS.CUSTOMER_OPEN_CREDIT,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_PAYMENTS.CUSTOMER_PAYMENTS_LIST,
    wrap<PaymentsListRequest, PaymentsListResponse>(
      (req) => {
        requireWorker();
        return { payments: listPaymentsForCustomer(db, req.customerId, req.limit) };
      },
      IPC_CHANNELS_PAYMENTS.CUSTOMER_PAYMENTS_LIST,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_SALE_DETAIL.SALE_GET_BY_ID,
    wrap<SaleGetByIdRequest, SaleGetByIdResponse>(
      (req) => {
        requireWorker();
        return getSaleById(db, req.saleId);
      },
      IPC_CHANNELS_SALE_DETAIL.SALE_GET_BY_ID,
    ),
  );
}
