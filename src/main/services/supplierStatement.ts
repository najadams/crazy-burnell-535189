// supplierStatement.ts — printable AP statement for one supplier.
// Mirror of the customer statement projection described in CLAUDE.md §6,
// but on the AP side: what we owe them, broken down by age bucket, with
// open invoices oldest-first and recent payments newest-first.
//
// The renderer mounts this in a modal with @media print rules so the
// owner can hand the supplier rep a paper statement at reconciliation
// time.

import type { Database } from 'better-sqlite3';

export interface SupplierStatementInput {
  supplierId: string;
  asOfDateISO?: string;       // defaults to today (YYYY-MM-DD)
  monthsOfPaymentHistory?: number;  // defaults to 6
}

export interface SupplierStatement {
  shop: {
    name: string;
    subtitle: string | null;
    ownerPhone: string | null;
  };
  supplier: {
    id: string;
    name: string;
    contactPhone: string | null;
    creditLimitPesewas: number;
    currentBalancePesewas: number;
  };
  asOfDate: string;
  aging: {
    bucket_0_30: number;
    bucket_31_60: number;
    bucket_61_90: number;
    bucket_90_plus: number;
    totalOpenPesewas: number;
  };
  openInvoices: Array<{
    invoiceId: string;
    invoiceNumber: string | null;
    invoiceDate: string;
    paymentTermsDays: number;
    dueDate: string;
    daysOverdue: number;        // 0 if not yet due
    totalPesewas: number;
    paidPesewas: number;
    openBalancePesewas: number;
  }>;
  recentPayments: Array<{
    paymentId: string;
    paidAt: string;
    amountPesewas: number;
    paymentMethod: string;
    paymentReference: string | null;
  }>;
  suggestedSettleByDate: string | null;  // earliest overdue due-date, or
                                         // earliest upcoming due-date if
                                         // nothing is overdue
}

export function buildSupplierStatement(
  db: Database, input: SupplierStatementInput,
): SupplierStatement {
  const asOfDate = input.asOfDateISO ?? new Date().toISOString().slice(0, 10);
  const monthsHistory = input.monthsOfPaymentHistory ?? 6;

  const supplier = db.prepare(
    `SELECT id, name, contact_phone AS contactPhone,
            credit_limit_pesewas AS creditLimitPesewas,
            current_balance_pesewas AS currentBalancePesewas
       FROM suppliers WHERE id = ?`,
  ).get(input.supplierId) as {
    id: string; name: string; contactPhone: string | null;
    creditLimitPesewas: number; currentBalancePesewas: number;
  } | undefined;
  if (!supplier) throw new Error('Supplier not found.');

  // device_config holds the shop header (name + subtitle + owner phone).
  // Rows are optional — fall back to defaults if the table is empty,
  // since this worktree may not have the device_config rows seeded.
  const cfg = db.prepare(
    `SELECT shop_name AS name, shop_subtitle AS subtitle,
            owner_phone AS ownerPhone
       FROM device_config LIMIT 1`,
  ).get() as { name: string; subtitle: string | null; ownerPhone: string | null }
    | undefined;

  // Open invoices with derived due-date and overdue days at asOfDate.
  const openInvoices = db.prepare(
    `SELECT * FROM (
       SELECT i.id AS invoiceId,
              i.invoice_number AS invoiceNumber,
              i.invoice_date AS invoiceDate,
              i.payment_terms_days AS paymentTermsDays,
              date(i.invoice_date, '+' || i.payment_terms_days || ' days') AS dueDate,
              i.total_pesewas AS totalPesewas,
              COALESCE(
                (SELECT SUM(amount_pesewas) FROM supplier_payment_allocations
                  WHERE invoice_id = i.id), 0
              ) AS paidPesewas,
              i.total_pesewas - COALESCE(
                (SELECT SUM(amount_pesewas) FROM supplier_payment_allocations
                  WHERE invoice_id = i.id), 0
              ) AS openBalancePesewas,
              CAST(julianday(?) - julianday(i.invoice_date) AS INTEGER) AS daysSinceInvoice
         FROM supplier_invoices i
        WHERE i.supplier_id = ? AND i.is_payable = 1 AND i.voided = 0
     )
     WHERE openBalancePesewas > 0
     ORDER BY invoiceDate ASC, invoiceId ASC`,
  ).all(asOfDate, input.supplierId) as Array<{
    invoiceId: string; invoiceNumber: string | null;
    invoiceDate: string; paymentTermsDays: number; dueDate: string;
    totalPesewas: number; paidPesewas: number;
    openBalancePesewas: number; daysSinceInvoice: number;
  }>;

  // Aging buckets indexed off invoice age (days since invoice_date).
  // Same bucketing as customer side: 0-30 / 31-60 / 61-90 / 90+.
  const aging = {
    bucket_0_30: 0,
    bucket_31_60: 0,
    bucket_61_90: 0,
    bucket_90_plus: 0,
    totalOpenPesewas: 0,
  };
  for (const inv of openInvoices) {
    const age = Math.max(0, inv.daysSinceInvoice);
    aging.totalOpenPesewas += inv.openBalancePesewas;
    if (age <= 30) aging.bucket_0_30 += inv.openBalancePesewas;
    else if (age <= 60) aging.bucket_31_60 += inv.openBalancePesewas;
    else if (age <= 90) aging.bucket_61_90 += inv.openBalancePesewas;
    else aging.bucket_90_plus += inv.openBalancePesewas;
  }

  const recentPayments = db.prepare(
    `SELECT id AS paymentId, paid_at AS paidAt,
            amount_pesewas AS amountPesewas,
            payment_method AS paymentMethod,
            payment_reference AS paymentReference
       FROM supplier_payments
      WHERE supplier_id = ?
        AND voided = 0
        AND paid_at >= date(?, '-' || ? || ' months')
      ORDER BY paid_at DESC`,
  ).all(input.supplierId, asOfDate, monthsHistory) as Array<{
    paymentId: string; paidAt: string;
    amountPesewas: number; paymentMethod: string;
    paymentReference: string | null;
  }>;

  // Suggested settle-by: the earliest overdue due-date (negative slack);
  // failing that, the earliest upcoming due-date. Null if nothing open.
  let suggestedSettleByDate: string | null = null;
  if (openInvoices.length > 0) {
    const overdue = openInvoices
      .filter((i) => i.dueDate < asOfDate)
      .map((i) => i.dueDate)
      .sort();
    const upcoming = openInvoices
      .filter((i) => i.dueDate >= asOfDate)
      .map((i) => i.dueDate)
      .sort();
    suggestedSettleByDate = overdue[0] ?? upcoming[0] ?? null;
  }

  return {
    shop: {
      name: cfg?.name ?? 'Counter',
      subtitle: cfg?.subtitle ?? null,
      ownerPhone: cfg?.ownerPhone ?? null,
    },
    supplier: {
      id: supplier.id,
      name: supplier.name,
      contactPhone: supplier.contactPhone,
      creditLimitPesewas: supplier.creditLimitPesewas,
      currentBalancePesewas: supplier.currentBalancePesewas,
    },
    asOfDate,
    aging,
    openInvoices: openInvoices.map((i) => ({
      invoiceId: i.invoiceId,
      invoiceNumber: i.invoiceNumber,
      invoiceDate: i.invoiceDate,
      paymentTermsDays: i.paymentTermsDays,
      dueDate: i.dueDate,
      daysOverdue: Math.max(
        0,
        Math.floor(
          (Date.parse(asOfDate) - Date.parse(i.dueDate)) / (1000 * 60 * 60 * 24),
        ),
      ),
      totalPesewas: i.totalPesewas,
      paidPesewas: i.paidPesewas,
      openBalancePesewas: i.openBalancePesewas,
    })),
    recentPayments,
    suggestedSettleByDate,
  };
}
