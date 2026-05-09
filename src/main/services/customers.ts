// customers.ts — list / get / recent-sales-per-customer.

import type { Database } from 'better-sqlite3';
import type { CustomerSummary } from '../../shared/types/ipc.js';

const SELECT_CUSTOMER = `
  SELECT id, display_name AS displayName, phone,
         customer_type AS customerType,
         current_balance_pesewas AS currentBalancePesewas,
         blocked
    FROM customers`;

export function listCustomers(db: Database, includeBlocked = false): CustomerSummary[] {
  const where = includeBlocked ? '' : 'WHERE blocked = 0';
  const rows = db.prepare(
    `${SELECT_CUSTOMER} ${where} ORDER BY display_name ASC`,
  ).all();
  return rows.map((r: any) => ({ ...r, blocked: !!r.blocked })) as CustomerSummary[];
}

export function getCustomer(db: Database, customerId: string): CustomerSummary {
  const row = db.prepare(
    `${SELECT_CUSTOMER} WHERE id = ?`,
  ).get(customerId) as any;
  if (!row) throw new Error('Customer not found.');
  return { ...row, blocked: !!row.blocked } as CustomerSummary;
}

export function recentSalesForCustomer(
  db: Database, customerId: string, limit = 20,
): Array<{
  id: string;
  createdAt: string;
  totalPesewas: number;
  voided: boolean;
  paymentMethod: string;
  lineCount: number;
}> {
  const rows = db.prepare(
    `SELECT s.id, s.created_at AS createdAt, s.total_pesewas AS totalPesewas,
            s.voided, s.payment_method AS paymentMethod,
            (SELECT COUNT(*) FROM sale_lines sl WHERE sl.sale_id = s.id) AS lineCount
       FROM sales s
      WHERE s.customer_id = ?
      ORDER BY s.created_at DESC
      LIMIT ?`,
  ).all(customerId, limit) as Array<any>;
  return rows.map((r) => ({ ...r, voided: !!r.voided }));
}
