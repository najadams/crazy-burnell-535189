// printing.ts — receipt and statement print helpers.
//
// Electron's contextIsolated renderer doesn't reliably print from a
// detached iframe (the original approach), so we use the portal +
// window.print() pattern instead:
//
//   1. A PrintableReceipt / PrintableStatement React component is
//      portalled to document.body (NOT a descendant of #root — the
//      @media print rule hides #root, so anything inside it would be
//      hidden too).
//   2. The component mounts a <div class="print-portal"> which is
//      display:none on screen and block during print. Inside it sits
//      the actual receipt/statement body.
//   3. On mount, the component calls window.print() (which is
//      synchronous in Chromium — blocks until the user dismisses the
//      OS dialog), logs the attempt to audit_log via IPC, then calls
//      onDone() so the parent screen can unmount the portal and
//      continue its flow.
//
// This module exports the data types and a small log helper. The
// React components live in PrintableReceipt.tsx and
// PrintableStatement.tsx so they can use hooks + JSX.

import { counter } from './ipc';
import type { PrintKind } from '../../shared/types/ipc';

// ---- Data shapes ----------------------------------------------------------

export interface ReceiptShop {
  shopName: string;
  shopSubtitle: string;
  ownerPhone: string | null;
}

export interface ReceiptLine {
  productName: string;
  quantity: number;
  unitPricePesewas: number;
}

export interface ReceiptData {
  saleId: string;
  createdAtISO: string;
  cashierName: string;
  customerName: string | null;
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  lines: ReceiptLine[];
  totalPesewas: number;
  cashPaidPesewas: number;
  momoPaidPesewas: number;
  bankPaidPesewas: number;
  creditPesewas: number;
  changePesewas: number;
}

export interface StatementOpenInvoice {
  saleId: string;
  createdAtISO: string;
  totalPesewas: number;
  remainingPesewas: number;
}

export interface StatementPayment {
  paymentId: string;
  createdAtISO: string;
  amountPesewas: number;
  paymentMethod: string;
}

export interface StatementCustomer {
  customerId: string;
  displayName: string;
  phone: string;
  creditLimitPesewas: number;
  currentBalancePesewas: number;
  blocked: boolean;
}

export interface StatementData {
  customer: StatementCustomer;
  asOfISO: string;
  openInvoices: StatementOpenInvoice[];
  recentPayments: StatementPayment[];
}

// ---- Helpers --------------------------------------------------------------

// Compact monospace-friendly timestamp for receipt headers. Same shape
// as the existing SaleDetailModal uses so receipts look consistent
// regardless of which path printed them.
export function formatReceiptDate(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

// Fire-and-forget audit log of a print attempt. Failures are
// logged-and-swallowed; we never want an audit-write failure to
// surface as a "print failed" error to the cashier.
export function logPrintAttempt(
  kind: PrintKind, entityId: string, context: Record<string, unknown>,
): void {
  void counter.logPrint({ kind, entityId, context }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('logPrint failed:', err);
  });
}
