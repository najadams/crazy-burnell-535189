// customersAdmin.ts — minimum: createCustomer.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { logAudit } from './auditQuery.js';

export interface CreateCustomerInput {
  displayName: string;
  phone: string;             // already in +233XXXXXXXXX form (renderer normalises)
  customerType: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  creditLimitPesewas: number;
  preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
}

export function createCustomer(
  db: Database, input: CreateCustomerInput, workerId: string, deviceId: string,
): { customerId: string } {
  if (!input.displayName.trim()) throw new Error('Customer name is required.');
  if (!/^\+233\d{9}$/.test(input.phone)) {
    throw new Error('Phone must be in +233XXXXXXXXX form.');
  }
  if (!Number.isInteger(input.creditLimitPesewas) || input.creditLimitPesewas < 0) {
    throw new Error('Credit limit must be a non-negative whole number of pesewas.');
  }

  const customerId = `cust-${uuidv4()}`;
  db.prepare(
    `INSERT INTO customers
       (id, display_name, phone, customer_type,
        credit_limit_pesewas, preferred_channel,
        created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    customerId, input.displayName.trim(), input.phone, input.customerType,
    input.creditLimitPesewas, input.preferredChannel,
    workerId, workerId, deviceId,
  );

  logAudit(db, {
    workerId,
    action: 'CUSTOMER_CREATED',
    entityType: 'customers',
    entityId: customerId,
    afterValue: input,
    deviceId,
  });

  return { customerId };
}
