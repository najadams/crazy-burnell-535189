// salesQuery.ts — read full sale (header + lines + names) for the
// detail / receipt-print view.

import type { Database } from 'better-sqlite3';

export interface SaleDetail {
  sale: {
    id: string;
    createdAt: string;
    channel: string;
    paymentMethod: string;
    isCredit: boolean;
    voided: boolean;
    voidedAt: string | null;
    voidReason: string | null;
    subtotalPesewas: number;
    totalPesewas: number;
  };
  customer: { id: string; displayName: string; phone: string } | null;
  worker: { id: string; fullName: string };
  lines: Array<{
    id: string;
    productId: string;
    productName: string;
    productSku: string;
    quantity: number;
    unitPricePesewas: number;
    lineTotalPesewas: number;
    kind: string;
  }>;
  shopHeader: {
    shopName: string;
    shopSubtitle: string;
    ownerPhone: string | null;
  };
  // Per-method tender breakdown for reprints. Computed from
  // sale_payments rows (after migration 0007). Pre-backfill legacy
  // sales may have all zeros — the caller falls back to displaying
  // sale.paymentMethod + sale.totalPesewas in that case.
  paymentBreakdown: {
    cashPaidPesewas: number;
    momoPaidPesewas: number;
    bankPaidPesewas: number;
    creditPesewas: number;
    changePesewas: number;
  };
}

export function getSaleById(db: Database, saleId: string): SaleDetail {
  const sale = db.prepare(
    `SELECT s.id, s.created_at AS createdAt, s.channel,
            s.payment_method AS paymentMethod,
            s.is_credit AS isCredit, s.voided,
            s.voided_at AS voidedAt, s.void_reason AS voidReason,
            s.subtotal_pesewas AS subtotalPesewas,
            s.total_pesewas AS totalPesewas,
            s.customer_id AS customerId,
            s.worker_id AS workerId
       FROM sales s WHERE s.id = ?`,
  ).get(saleId) as any;
  if (!sale) throw new Error('Sale not found.');

  let customer: SaleDetail['customer'] = null;
  if (sale.customerId) {
    const c = db.prepare(
      `SELECT id, display_name AS displayName, phone
         FROM customers WHERE id = ?`,
    ).get(sale.customerId) as any;
    if (c) customer = c;
  }

  const worker = db.prepare(
    `SELECT id, full_name AS fullName FROM workers WHERE id = ?`,
  ).get(sale.workerId) as { id: string; fullName: string };

  const lines = db.prepare(
    `SELECT sl.id, sl.product_id AS productId,
            p.name AS productName, p.sku AS productSku,
            sl.quantity, sl.unit_price_pesewas AS unitPricePesewas,
            sl.line_total_pesewas AS lineTotalPesewas, sl.kind
       FROM sale_lines sl
       JOIN products p ON p.id = sl.product_id
      WHERE sl.sale_id = ?
      ORDER BY sl.id ASC`,
  ).all(saleId) as SaleDetail['lines'];

  const shopHeader = (db.prepare(
    `SELECT shop_name AS shopName, shop_subtitle AS shopSubtitle,
            owner_phone AS ownerPhone
       FROM device_config WHERE id = 1`,
  ).get() as SaleDetail['shopHeader']) ?? {
    shopName: 'Counter Shop', shopSubtitle: '', ownerPhone: null,
  };

  // Sum sale_payments by method so reprints can show "Cash X, MoMo Y,
  // On credit Z, Change W". Change is computed across CASH rows from
  // (cash_given - amount) — the per-row excess. Non-cash rows have
  // no cash_given.
  const breakdownRow = db.prepare(
    `SELECT
        COALESCE(SUM(CASE WHEN payment_method='CASH'   THEN amount_pesewas END), 0) AS cashPaidPesewas,
        COALESCE(SUM(CASE WHEN payment_method='MOMO'   THEN amount_pesewas END), 0) AS momoPaidPesewas,
        COALESCE(SUM(CASE WHEN payment_method='BANK'   THEN amount_pesewas END), 0) AS bankPaidPesewas,
        COALESCE(SUM(CASE WHEN payment_method='CREDIT' THEN amount_pesewas END), 0) AS creditPesewas,
        COALESCE(SUM(CASE WHEN payment_method='CASH'
                          THEN COALESCE(cash_given_pesewas, amount_pesewas) - amount_pesewas
                          END), 0) AS changePesewas
       FROM sale_payments WHERE sale_id = ?`,
  ).get(saleId) as SaleDetail['paymentBreakdown'];

  return {
    sale: {
      id: sale.id, createdAt: sale.createdAt, channel: sale.channel,
      paymentMethod: sale.paymentMethod,
      isCredit: !!sale.isCredit, voided: !!sale.voided,
      voidedAt: sale.voidedAt, voidReason: sale.voidReason,
      subtotalPesewas: sale.subtotalPesewas, totalPesewas: sale.totalPesewas,
    },
    customer, worker, lines, shopHeader,
    paymentBreakdown: breakdownRow,
  };
}
