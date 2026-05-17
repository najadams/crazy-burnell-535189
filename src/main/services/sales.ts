// sales.ts — create a sale (lines + stock movements + payment rows +
// audit row).
//
// Payment model after migration 0007: every sale produces one or more
// `sale_payments` rows whose amounts sum to the sale's total. A pure
// cash sale = one CASH row. A pure credit sale = one CREDIT row. A
// partial = a CASH/MOMO/BANK row plus a CREDIT row (or, less common,
// multiple cash-like rows plus a CREDIT row, e.g. someone hands over
// some cash AND a MoMo payment AND owes the rest).
//
// The input is shape-tolerant: callers may pass either
//   - the legacy `{paymentMethod, cashTenderedPesewas}` pair (used by
//     the current SaleScreen, which sends one tender per sale), or
//   - the new `{payments: [...]}` array, one entry per tender.
// If `payments` is provided it wins; the legacy fields are ignored.
// The single-tender legacy path is normalised internally to a one-row
// `payments` array so there's one code path past the normalisation
// step. Chunk 2 of the part-payment work will switch the SaleScreen to
// the array shape; until then the legacy path stays the production
// surface.
//
// Credit-limit enforcement: when any CREDIT tender is present, the
// customer's projected balance (`current_balance_pesewas + credit
// portion`) is compared against `credit_limit_pesewas`. If it would
// exceed the limit, the caller must supply `supervisorApprovalId`
// (purpose OVER_LIMIT_PARTIAL); the service consumes the approval
// inside the same transaction that writes the sale, so a duplicate
// completion attempt can't reuse the same approval.
//
// For the demo we trust the renderer's unitPrice / unitCost on each
// line — the renderer pulled them from products. The full pricing-
// precedence flow (Section 4) would re-resolve at sale time.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import type { SaleLineInput } from '../../shared/types/ipc.js';
import { logAudit } from './auditQuery.js';
import { consumeSupervisorApproval } from './supervisorApprovals.js';
import { assertNotSealed } from './periods.js';
import { computeBonusLines } from './promotions.js';

export type PaymentMethod = 'CASH' | 'MOMO' | 'BANK' | 'CREDIT';

export interface PaymentTenderInput {
  method: PaymentMethod;
  amountPesewas: number;
  // MoMo transaction id, bank slip, etc. Optional for any method;
  // typically present on MOMO/BANK and absent on CASH/CREDIT.
  paymentReference?: string;
  // For CASH only: what the customer handed over. May exceed
  // amountPesewas, with the difference contributing to change due.
  // Ignored for non-CASH methods.
  cashGivenPesewas?: number;
}

export interface CreateSaleInput {
  shiftId: string;
  workerId: string;
  locationId: string;
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  customerId: string | null;
  lines: SaleLineInput[];

  // ---- New multi-tender shape (preferred) ----
  payments?: PaymentTenderInput[];

  // ---- Legacy single-tender shape (still supported) ----
  paymentMethod?: PaymentMethod;
  cashTenderedPesewas?: number;

  // Required if the CREDIT portion pushes the customer over their
  // credit limit. The approval must have purpose OVER_LIMIT_PARTIAL
  // and is consumed inside this transaction.
  supervisorApprovalId?: string;
}

export interface CreateSaleResult {
  saleId: string;
  totalPesewas: number;
  changePesewas: number;
  // Echoed back so the renderer can show "Paid X, on credit Y" without
  // a follow-up round trip.
  cashPaidPesewas: number;
  momoPaidPesewas: number;
  bankPaidPesewas: number;
  creditPesewas: number;
}

export function createSale(
  db: Database, input: CreateSaleInput, deviceId: string,
): CreateSaleResult {
  // ---- 1. Validate lines ----
  if (input.lines.length === 0) {
    throw new Error('Add at least one line before completing the sale.');
  }
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error('Line quantity must be a positive whole number.');
    }
    if (!Number.isInteger(line.unitPricePesewas) || line.unitPricePesewas < 0) {
      throw new Error('Unit price must be a non-negative whole number of pesewas.');
    }
    if (!Number.isInteger(line.unitCostPesewas) || line.unitCostPesewas < 0) {
      throw new Error('Unit cost must be a non-negative whole number of pesewas.');
    }
  }

  // ---- 2. Compute totals ----
  const subtotal = input.lines.reduce(
    (s, l) => s + l.unitPricePesewas * l.quantity, 0,
  );
  const total = subtotal;            // no discounts/taxes in demo

  // ---- 3. Normalise tenders ----
  // Either `payments` is the source of truth, or the legacy fields are
  // promoted into a one-row array. Past this block the rest of the
  // service treats every sale as multi-tender.
  const tenders: PaymentTenderInput[] = normaliseTenders(input, total);
  validateTenderShapes(tenders);

  const sumPaid = tenders.reduce((s, t) => s + t.amountPesewas, 0);
  if (sumPaid !== total) {
    throw new Error(
      `Payments sum to ₵${(sumPaid / 100).toFixed(2)} but sale total is ₵${(total / 100).toFixed(2)}.`,
    );
  }

  // Aggregate amounts by method for the result, balance math, and the
  // audit-log snapshot.
  const cashPaid   = tenders.filter((t) => t.method === 'CASH'  ).reduce((s, t) => s + t.amountPesewas, 0);
  const momoPaid   = tenders.filter((t) => t.method === 'MOMO'  ).reduce((s, t) => s + t.amountPesewas, 0);
  const bankPaid   = tenders.filter((t) => t.method === 'BANK'  ).reduce((s, t) => s + t.amountPesewas, 0);
  const creditOwed = tenders.filter((t) => t.method === 'CREDIT').reduce((s, t) => s + t.amountPesewas, 0);

  const isCredit = creditOwed > 0 ? 1 : 0;
  if (isCredit && !input.customerId) {
    throw new Error('Credit sales require a customer.');
  }

  // Change due = total cash handed over minus total cash applied. The
  // applied portion is `cashPaid` (sum of CASH tender amounts); the
  // handed-over portion is the sum of cash_given fields on CASH
  // tenders (falling back to the amount when the field is omitted).
  const cashHandedOver = tenders
    .filter((t) => t.method === 'CASH')
    .reduce((s, t) => s + (t.cashGivenPesewas ?? t.amountPesewas), 0);
  const change = cashHandedOver - cashPaid;

  // ---- 4. Credit-limit gate ----
  let overLimit = false;
  let projectedBalance = 0;
  let creditLimit = 0;
  if (isCredit) {
    const cust = db.prepare(
      `SELECT credit_limit_pesewas AS creditLimit,
              current_balance_pesewas AS currentBalance,
              display_name AS displayName,
              blocked
         FROM customers WHERE id = ?`,
    ).get(input.customerId!) as
      | { creditLimit: number; currentBalance: number; displayName: string; blocked: number }
      | undefined;
    if (!cust) throw new Error('Customer not found.');
    if (cust.blocked) {
      throw new Error(`${cust.displayName} is blocked — cannot extend further credit.`);
    }
    creditLimit = cust.creditLimit;
    projectedBalance = cust.currentBalance + creditOwed;
    overLimit = projectedBalance > creditLimit;
    if (overLimit && !input.supervisorApprovalId) {
      // The thrown error includes both numbers so the cashier can
      // explain the gate to the customer ("You'd be at ₵X owed,
      // your limit is ₵Y").
      throw new Error(
        `This sale would put ${cust.displayName} at ₵${(projectedBalance / 100).toFixed(2)} owed, above the ₵${(creditLimit / 100).toFixed(2)} credit limit. A supervisor PIN is needed to override.`,
      );
    }
  }

  // ---- 5. Persist ----
  const saleId = `sale-${uuidv4()}`;
  // The summary `payment_method` on the sales row: literal method when
  // there's exactly one tender, MIXED otherwise. Preserves the legacy
  // column's usefulness for quick filters while the per-row truth
  // lives in sale_payments.
  const summaryMethod: 'CASH' | 'MOMO' | 'BANK' | 'CREDIT' | 'MIXED' =
    tenders.length === 1 ? tenders[0].method : 'MIXED';

  const tx = db.transaction(() => {
    // Day-lock gate. createSale records into today's books at the
    // sale's location; if that day is sealed, refuse. The check is
    // inside the tx so the seal can't be lifted between check and
    // write by another (hypothetical) concurrent operation.
    assertNotSealed(db, input.locationId, new Date().toISOString(), 'Completing this sale');

    // Consume the supervisor approval inside the tx. If the approval
    // is already used / expired / wrong purpose, the throw rolls the
    // whole sale back. A duplicate completion attempt with the same
    // approval id will fail here on the second pass — single-use is
    // enforced by the consume function.
    if (overLimit) {
      consumeSupervisorApproval(db, {
        approvalId: input.supervisorApprovalId!,
        expectedPurpose: 'OVER_LIMIT_PARTIAL',
        action: 'SALE_CREATED',
        entityId: saleId,
      });
    }

    db.prepare(
      `INSERT INTO sales
         (id, shift_id, worker_id, location_id, channel, customer_id,
          subtotal_pesewas, total_pesewas, is_credit, payment_method,
          created_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      saleId, input.shiftId, input.workerId, input.locationId,
      input.channel, input.customerId,
      subtotal, total, isCredit, summaryMethod,
      input.workerId, deviceId,
    );

    const lineStmt = db.prepare(
      `INSERT INTO sale_lines
         (id, sale_id, product_id, quantity,
          unit_price_pesewas, unit_cost_pesewas,
          line_total_pesewas, margin_pesewas, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REGULAR')`,
    );
    const stockStmt = db.prepare(
      `INSERT INTO stock_movements
         (id, product_id, location_id, quantity, reason_code,
          shift_id, worker_id, customer_id,
          unit_cost_pesewas, total_value_pesewas,
          created_by, device_id)
       VALUES (?, ?, ?, ?, 'SALE', ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const line of input.lines) {
      const lineTotal = line.unitPricePesewas * line.quantity;
      const margin = (line.unitPricePesewas - line.unitCostPesewas) * line.quantity;
      lineStmt.run(
        `sl-${uuidv4()}`, saleId, line.productId, line.quantity,
        line.unitPricePesewas, line.unitCostPesewas,
        lineTotal, margin,
      );
      // Stock outflow: negative quantity per the spec.
      stockStmt.run(
        `sm-${uuidv4()}`, line.productId, input.locationId,
        -line.quantity,
        input.shiftId, input.workerId, input.customerId ?? null,
        line.unitCostPesewas, line.unitCostPesewas * line.quantity,
        input.workerId, deviceId,
      );
    }

    // Bonus-unit promotions (Section 5). After regular lines are
    // written, run the bonus-line algorithm and emit BONUS sale_lines
    // (unit_price=0, negative margin = -(cost × qty)) plus matching
    // stock outflows.
    const atDate = new Date().toISOString().slice(0, 10);
    const bonusLines = computeBonusLines(
      db, input.channel, atDate,
      input.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
    );
    const bonusStmt = db.prepare(
      `INSERT INTO sale_lines
         (id, sale_id, product_id, quantity,
          unit_price_pesewas, unit_cost_pesewas,
          line_total_pesewas, margin_pesewas,
          kind, applied_promotion_id)
       VALUES (?, ?, ?, ?, 0, ?, 0, ?, 'BONUS', ?)`,
    );
    for (const b of bonusLines) {
      const margin = -(b.unitCostPesewas * b.quantity);
      bonusStmt.run(
        `sl-${uuidv4()}`, saleId, b.productId, b.quantity,
        b.unitCostPesewas, margin, b.promotionId,
      );
      stockStmt.run(
        `sm-${uuidv4()}`, b.productId, input.locationId,
        -b.quantity,
        input.shiftId, input.workerId, input.customerId ?? null,
        b.unitCostPesewas, b.unitCostPesewas * b.quantity,
        input.workerId, deviceId,
      );
    }

    // ---- sale_payments rows: one per tender. The invariant
    // SUM(amount_pesewas) = total is upheld by the sumPaid check
    // above; no CHECK constraint enforces it because SQLite can't
    // express cross-row constraints, so service code is the gate. ----
    const payStmt = db.prepare(
      `INSERT INTO sale_payments
         (id, sale_id, payment_method, amount_pesewas,
          payment_reference, cash_given_pesewas,
          created_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of tenders) {
      payStmt.run(
        `sp-${uuidv4()}`, saleId, t.method, t.amountPesewas,
        t.paymentReference ?? null,
        t.method === 'CASH' ? (t.cashGivenPesewas ?? t.amountPesewas) : null,
        input.workerId, deviceId,
      );
    }

    // ---- Customer balance bump: by the CREDIT portion only, never
    // by the total. A partial sale of ₵100 with ₵60 CASH + ₵40
    // CREDIT bumps the balance by ₵40, not ₵100. ----
    if (isCredit && input.customerId) {
      db.prepare(
        `UPDATE customers
            SET current_balance_pesewas = current_balance_pesewas + ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                updated_by = ?
          WHERE id = ?`,
      ).run(creditOwed, input.workerId, input.customerId);
    }

    logAudit(db, {
      workerId: input.workerId,
      action: 'SALE_CREATED',
      entityType: 'sales',
      entityId: saleId,
      afterValue: {
        total,
        channel: input.channel,
        summaryMethod,
        customerId: input.customerId,
        lineCount: input.lines.length,
        tenders: tenders.map((t) => ({
          method: t.method, amount: t.amountPesewas,
          ...(t.paymentReference ? { reference: t.paymentReference } : {}),
          ...(t.cashGivenPesewas != null ? { cashGiven: t.cashGivenPesewas } : {}),
        })),
        ...(overLimit ? {
          overLimit: true,
          creditLimit,
          projectedBalance,
          supervisorApprovalId: input.supervisorApprovalId,
        } : {}),
      },
      deviceId,
    });
  });
  tx();

  return {
    saleId,
    totalPesewas: total,
    changePesewas: change,
    cashPaidPesewas: cashPaid,
    momoPaidPesewas: momoPaid,
    bankPaidPesewas: bankPaid,
    creditPesewas: creditOwed,
  };
}

// Convert whichever input shape the caller used into the canonical
// multi-tender array. Centralised so the rest of createSale only
// reads from one place.
function normaliseTenders(input: CreateSaleInput, total: number): PaymentTenderInput[] {
  if (input.payments && input.payments.length > 0) {
    // New shape wins outright; ignore the legacy fields if both are
    // somehow set (defensive — the input type permits it for backward
    // compatibility but a well-behaved caller picks one).
    return input.payments.map((t) => ({ ...t }));
  }
  // Legacy single-tender. Default to CASH if neither field is set —
  // matches the pre-change behaviour of the service.
  const method: PaymentMethod = input.paymentMethod ?? 'CASH';
  const tender: PaymentTenderInput = { method, amountPesewas: total };
  if (method === 'CASH') {
    tender.cashGivenPesewas = input.cashTenderedPesewas ?? total;
  }
  return [tender];
}

function validateTenderShapes(tenders: PaymentTenderInput[]): void {
  if (tenders.length === 0) {
    throw new Error('A sale must have at least one payment tender.');
  }
  let creditCount = 0;
  for (const t of tenders) {
    if (!['CASH', 'MOMO', 'BANK', 'CREDIT'].includes(t.method)) {
      throw new Error(`Unknown payment method: ${t.method}`);
    }
    if (!Number.isInteger(t.amountPesewas) || t.amountPesewas <= 0) {
      throw new Error('Tender amount must be a positive whole number of pesewas.');
    }
    if (t.method === 'CASH' && t.cashGivenPesewas != null) {
      if (!Number.isInteger(t.cashGivenPesewas) || t.cashGivenPesewas < t.amountPesewas) {
        throw new Error('Cash given must be a whole number ≥ the tender amount.');
      }
    }
    if (t.method === 'CREDIT') creditCount++;
  }
  if (creditCount > 1) {
    // Multiple CREDIT rows would technically work mathematically but
    // they collapse to one logical concept (the customer owes some
    // amount). Refuse the shape to keep audit reads simple.
    throw new Error('Only one CREDIT tender is allowed per sale.');
  }
}

export function recentSales(db: Database, limit = 20): Array<{
  id: string;
  createdAt: string;
  totalPesewas: number;
  customerId: string | null;
  customerName: string | null;
  workerName: string;
  voided: boolean;
}> {
  const rows = db.prepare(
    `SELECT s.id, s.created_at AS createdAt, s.total_pesewas AS totalPesewas,
            s.customer_id AS customerId,
            c.display_name AS customerName,
            w.full_name    AS workerName,
            s.voided
       FROM sales s
       JOIN workers w ON w.id = s.worker_id
       LEFT JOIN customers c ON c.id = s.customer_id
      ORDER BY s.created_at DESC LIMIT ?`,
  ).all(limit) as Array<any>;
  return rows.map((r) => ({ ...r, voided: !!r.voided }));
}
