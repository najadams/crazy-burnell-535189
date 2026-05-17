// pendingOrders.ts — Wave G chunk 1. The depot lead takes a phone
// order (or transcribes a WhatsApp message, or types a walk-up), and
// the resulting `pending_orders` row is the system-of-record entity
// distinct from a completed `sales` row. The line items are captured
// at intake with a price snapshot; the actual sale is rung up later
// via convertToSale once the driver has delivered and brought back
// the collected payment.
//
// The depot-only flow (before Stage 4D delivery_attempts ship):
//   1. createPendingOrder(...)            → status='CREATED'
//   2. driver hand-delivers, off-system
//   3. convertToSale(orderId, payments)   → status='CONVERTED',
//                                            sales row written via
//                                            sales.createSale
//
// Edits to lines are allowed only while status='CREATED'. Once
// converted or cancelled, the row is read-only; an OWNER reversal
// requires voiding the resulting sale separately.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';
import { createSale, type PaymentTenderInput } from './sales.js';

export type IntakeChannel = 'MANUAL' | 'PHONE_CALL' | 'WHATSAPP_TEXT';

export type PendingOrderStatus =
  | 'CREATED' | 'ASSIGNED' | 'PICKED' | 'OUT_FOR_DELIVERY'
  | 'DELIVERED' | 'FAILED' | 'CONVERTED' | 'CANCELLED';

export interface PendingOrderLineInput {
  productId: string;
  quantity: number;
  unitPricePesewasAtIntake: number;
  notes?: string;
}

export interface CreatePendingOrderInput {
  customerId: string;
  intakeChannel: IntakeChannel;
  intakeWorkerId: string;        // who captured it (cashier/depot lead)
  requestedDeliveryDate?: string | null;
  requiresReview?: boolean;
  lines: PendingOrderLineInput[];
}

export interface PendingOrderRow {
  id: string;
  customerId: string;
  customerName: string | null;
  intakeChannel: IntakeChannel;
  intakeWorkerId: string;
  intakeWorkerName: string | null;
  status: PendingOrderStatus;
  requiresReview: boolean;
  requestedDeliveryDate: string | null;
  assignedRouteRunId: string | null;
  conversionSaleId: string | null;
  convertedAt: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  // Derived for list views.
  totalAtIntakePesewas: number;
  lineCount: number;
}

export interface PendingOrderLineRow {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPricePesewasAtIntake: number;
  lineTotalPesewasAtIntake: number;
  notes: string | null;
}

// --- validation helpers --------------------------------------------------

function validateLines(lines: PendingOrderLineInput[]): void {
  if (lines.length === 0) {
    throw new Error('A pending order must have at least one line.');
  }
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw new Error('Line quantity must be a positive whole number.');
    }
    if (!Number.isInteger(l.unitPricePesewasAtIntake) || l.unitPricePesewasAtIntake < 0) {
      throw new Error('Line unit price must be a non-negative whole number of pesewas.');
    }
  }
}

// --- create ---------------------------------------------------------------

export function createPendingOrder(
  db: Database, input: CreatePendingOrderInput, deviceId: string,
): { pendingOrderId: string } {
  validateLines(input.lines);

  // Customer must exist and not be blocked. Blocked customers can't
  // accumulate new orders; an OWNER must unblock first.
  const cust = db.prepare(
    `SELECT id, blocked, display_name AS displayName
       FROM customers WHERE id = ?`,
  ).get(input.customerId) as
    | { id: string; blocked: 0 | 1; displayName: string }
    | undefined;
  if (!cust) throw new Error('Customer not found.');
  if (cust.blocked) {
    throw new Error(`${cust.displayName} is blocked — cannot create new orders.`);
  }

  const pendingOrderId = `po-${uuidv4()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO pending_orders
         (id, customer_id, intake_channel, intake_worker_id,
          requested_delivery_date, requires_review,
          created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pendingOrderId, input.customerId, input.intakeChannel,
      input.intakeWorkerId,
      input.requestedDeliveryDate ?? null,
      input.requiresReview ? 1 : 0,
      input.intakeWorkerId, input.intakeWorkerId, deviceId,
    );

    const lineStmt = db.prepare(
      `INSERT INTO pending_order_lines
         (id, pending_order_id, product_id, quantity,
          unit_price_pesewas_at_intake, notes,
          created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of input.lines) {
      lineStmt.run(
        `pol-${uuidv4()}`, pendingOrderId, l.productId, l.quantity,
        l.unitPricePesewasAtIntake, l.notes?.trim() || null,
        input.intakeWorkerId, input.intakeWorkerId, deviceId,
      );
    }

    logAudit(db, {
      workerId: input.intakeWorkerId,
      action: 'PENDING_ORDER_CREATED',
      entityType: 'pending_orders',
      entityId: pendingOrderId,
      afterValue: {
        customerId: input.customerId,
        intakeChannel: input.intakeChannel,
        lineCount: input.lines.length,
        requiresReview: !!input.requiresReview,
      },
      deviceId,
    });
  });
  tx();
  return { pendingOrderId };
}

// --- reads -----------------------------------------------------------------

const SELECT_ORDER_BASE = `
  SELECT po.id, po.customer_id AS customerId,
         c.display_name AS customerName,
         po.intake_channel AS intakeChannel,
         po.intake_worker_id AS intakeWorkerId,
         w.full_name AS intakeWorkerName,
         po.status, po.requires_review AS requiresReview,
         po.requested_delivery_date AS requestedDeliveryDate,
         po.assigned_route_run_id AS assignedRouteRunId,
         po.conversion_sale_id AS conversionSaleId,
         po.converted_at AS convertedAt,
         po.cancel_reason AS cancelReason,
         po.cancelled_at AS cancelledAt,
         po.created_at AS createdAt,
         COALESCE((
           SELECT SUM(pol.quantity * pol.unit_price_pesewas_at_intake)
             FROM pending_order_lines pol
            WHERE pol.pending_order_id = po.id
         ), 0) AS totalAtIntakePesewas,
         (SELECT COUNT(*) FROM pending_order_lines pol2
           WHERE pol2.pending_order_id = po.id) AS lineCount
    FROM pending_orders po
    LEFT JOIN customers c ON c.id = po.customer_id
    LEFT JOIN workers   w ON w.id = po.intake_worker_id`;

function rowToOrder(r: any): PendingOrderRow {
  return {
    ...r,
    requiresReview: !!r.requiresReview,
  } as PendingOrderRow;
}

export interface ListPendingOrdersInput {
  status?: PendingOrderStatus | 'OPEN' | 'CLOSED';   // OPEN = not CONVERTED/CANCELLED; CLOSED = either of those
  customerId?: string;
  routeRunId?: string;
  limit?: number;
}

export function listPendingOrders(
  db: Database, input: ListPendingOrdersInput = {},
): PendingOrderRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.customerId) { where.push('po.customer_id = ?'); params.push(input.customerId); }
  if (input.routeRunId) { where.push('po.assigned_route_run_id = ?'); params.push(input.routeRunId); }
  if (input.status === 'OPEN') {
    where.push("po.status NOT IN ('CONVERTED','CANCELLED')");
  } else if (input.status === 'CLOSED') {
    where.push("po.status IN ('CONVERTED','CANCELLED')");
  } else if (input.status) {
    where.push('po.status = ?'); params.push(input.status);
  }
  const sql = `${SELECT_ORDER_BASE}
   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
   ORDER BY po.created_at DESC
   LIMIT ?`;
  params.push(input.limit ?? 50);
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToOrder);
}

export function getPendingOrder(db: Database, pendingOrderId: string): {
  order: PendingOrderRow; lines: PendingOrderLineRow[];
} {
  const order = db.prepare(`${SELECT_ORDER_BASE} WHERE po.id = ?`).get(pendingOrderId) as any;
  if (!order) throw new Error('Pending order not found.');
  const lines = db.prepare(
    `SELECT pol.id, pol.product_id AS productId,
            p.name AS productName,
            pol.quantity,
            pol.unit_price_pesewas_at_intake AS unitPricePesewasAtIntake,
            (pol.quantity * pol.unit_price_pesewas_at_intake) AS lineTotalPesewasAtIntake,
            pol.notes
       FROM pending_order_lines pol
       JOIN products p ON p.id = pol.product_id
      WHERE pol.pending_order_id = ?
      ORDER BY pol.created_at ASC`,
  ).all(pendingOrderId) as PendingOrderLineRow[];
  return { order: rowToOrder(order), lines };
}

// --- mutations -------------------------------------------------------------

export function updatePendingOrderLines(
  db: Database,
  input: {
    pendingOrderId: string;
    workerId: string;
    lines: PendingOrderLineInput[];
  },
  deviceId: string,
): void {
  validateLines(input.lines);
  const order = db.prepare(
    `SELECT id, status FROM pending_orders WHERE id = ?`,
  ).get(input.pendingOrderId) as { id: string; status: PendingOrderStatus } | undefined;
  if (!order) throw new Error('Pending order not found.');
  if (order.status !== 'CREATED') {
    throw new Error(`Lines can only be edited while status='CREATED' (current: ${order.status}).`);
  }

  const tx = db.transaction(() => {
    // Replace-all: delete existing lines + insert the new set. Simpler
    // than diffing; the audit_log captures the before/after counts.
    const before = db.prepare(
      `SELECT COUNT(*) AS n FROM pending_order_lines WHERE pending_order_id = ?`,
    ).get(input.pendingOrderId) as { n: number };

    db.prepare(`DELETE FROM pending_order_lines WHERE pending_order_id = ?`).run(input.pendingOrderId);

    const lineStmt = db.prepare(
      `INSERT INTO pending_order_lines
         (id, pending_order_id, product_id, quantity,
          unit_price_pesewas_at_intake, notes,
          created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of input.lines) {
      lineStmt.run(
        `pol-${uuidv4()}`, input.pendingOrderId, l.productId, l.quantity,
        l.unitPricePesewasAtIntake, l.notes?.trim() || null,
        input.workerId, input.workerId, deviceId,
      );
    }

    db.prepare(
      `UPDATE pending_orders
          SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(input.workerId, input.pendingOrderId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'PENDING_ORDER_LINES_UPDATED',
      entityType: 'pending_orders',
      entityId: input.pendingOrderId,
      beforeValue: { lineCount: before.n },
      afterValue: { lineCount: input.lines.length },
      deviceId,
    });
  });
  tx();
}

export function cancelPendingOrder(
  db: Database,
  input: { pendingOrderId: string; workerId: string; reason: string },
  deviceId: string,
): void {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new Error('Cancel reason is required (at least a few characters).');
  }
  const order = db.prepare(
    `SELECT id, status FROM pending_orders WHERE id = ?`,
  ).get(input.pendingOrderId) as { id: string; status: PendingOrderStatus } | undefined;
  if (!order) throw new Error('Pending order not found.');
  if (order.status === 'CONVERTED') {
    throw new Error('Order has already been converted to a sale and cannot be cancelled.');
  }
  if (order.status === 'CANCELLED') {
    throw new Error('Order is already cancelled.');
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE pending_orders
          SET status = 'CANCELLED',
              cancel_reason = ?,
              cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(input.reason.trim(), input.workerId, input.pendingOrderId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'PENDING_ORDER_CANCELLED',
      entityType: 'pending_orders',
      entityId: input.pendingOrderId,
      beforeValue: { status: order.status },
      afterValue: { reason: input.reason.trim() },
      deviceId,
    });
  });
  tx();
}

// --- conversion to sale ----------------------------------------------------

export interface ConvertToSaleInput {
  pendingOrderId: string;
  workerId: string;
  // Sale-time context. The convert flow runs at depot after the
  // driver has come back with whatever the customer paid; this
  // breakdown drives the sales' sale_payments rows.
  shiftId: string;
  locationId: string;
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  payments: PaymentTenderInput[];
  supervisorApprovalId?: string;
}

export function convertToSale(
  db: Database, input: ConvertToSaleInput, deviceId: string,
): { saleId: string } {
  const detail = getPendingOrder(db, input.pendingOrderId);
  if (detail.order.status === 'CONVERTED') {
    throw new Error('Order has already been converted.');
  }
  if (detail.order.status === 'CANCELLED') {
    throw new Error('Cannot convert a cancelled order.');
  }
  if (detail.lines.length === 0) {
    throw new Error('Order has no lines to convert.');
  }

  // Look up each product's current cost so the sale_lines get an
  // honest cost_pesewas (the intake price is what the customer was
  // quoted, but margin uses the cost at sale time).
  const costStmt = db.prepare(
    `SELECT cost_price_pesewas AS costPesewas FROM products WHERE id = ?`,
  );
  const saleLines = detail.lines.map((l) => {
    const c = costStmt.get(l.productId) as { costPesewas: number } | undefined;
    return {
      productId: l.productId,
      quantity: l.quantity,
      unitPricePesewas: l.unitPricePesewasAtIntake,
      unitCostPesewas: c?.costPesewas ?? 0,
    };
  });

  let saleId = '';
  const tx = db.transaction(() => {
    // createSale already wraps in its own transaction; nesting here
    // is safe because better-sqlite3 collapses nested transactions
    // into the outer one — failure rolls everything back.
    const result = createSale(db, {
      shiftId: input.shiftId,
      workerId: input.workerId,
      locationId: input.locationId,
      channel: input.channel,
      customerId: detail.order.customerId,
      lines: saleLines,
      payments: input.payments,
      supervisorApprovalId: input.supervisorApprovalId,
    }, deviceId);
    saleId = result.saleId;

    db.prepare(
      `UPDATE pending_orders
          SET status = 'CONVERTED',
              conversion_sale_id = ?,
              converted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(saleId, input.workerId, input.pendingOrderId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'PENDING_ORDER_CONVERTED',
      entityType: 'pending_orders',
      entityId: input.pendingOrderId,
      beforeValue: { status: detail.order.status },
      afterValue: { saleId, lineCount: detail.lines.length },
      deviceId,
    });
  });
  tx();
  return { saleId };
}
