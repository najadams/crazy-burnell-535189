// seed.ts — first-run defaults so the app boots with a usable shape:
// one OWNER worker (PIN 1234), one location, a handful of common
// Ghanaian beverages, a few customers, and the Wave H loyalty
// thresholds. Idempotent — runs on every boot but is a no-op once
// defaults exist.
//
// PIN 1234 is for the demo. The OWNER should change it from
// Settings → Workers in real use; that flow is part of the spec but
// out of scope for this scaffold.

import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { ensureLoyaltyDefaults } from '../services/loyaltyTiers.js';

const DEMO_OWNER_PIN = '1234';
const DEFAULT_DEVICE_ID = 'd-counter-1';

export function ensureDefaults(db: Database, deviceId: string = DEFAULT_DEVICE_ID): {
  ownerId: string;
  locationId: string;
  seeded: boolean;
} {
  // Existing OWNER? Use them.
  const existingOwner = db.prepare(
    `SELECT id FROM workers WHERE role IN ('OWNER','FOUNDER') AND active = 1
     ORDER BY created_at ASC LIMIT 1`,
  ).get() as { id: string } | undefined;

  let ownerId: string;
  let locationId: string;
  let seeded = false;

  const tx = db.transaction(() => {
    if (existingOwner) {
      ownerId = existingOwner.id;
    } else {
      ownerId = `w-${uuidv4()}`;
      const pinHash = bcrypt.hashSync(DEMO_OWNER_PIN, 12);
      db.prepare(
        `INSERT INTO workers (id, full_name, role, pin_hash, device_id)
         VALUES (?, ?, 'OWNER', ?, ?)`,
      ).run(ownerId, 'Naj', pinHash, deviceId);
      seeded = true;
    }

    // Location.
    const existingLoc = db.prepare(
      `SELECT id FROM locations WHERE active = 1 ORDER BY created_at ASC LIMIT 1`,
    ).get() as { id: string } | undefined;

    if (existingLoc) {
      locationId = existingLoc.id;
    } else {
      locationId = `loc-${uuidv4()}`;
      db.prepare(
        `INSERT INTO locations (id, name, created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(locationId, 'Depot', ownerId, ownerId, deviceId);
      seeded = true;
    }

    // Products. Walk-in / wholesale / route prices in pesewas. Cost
    // chosen so margin is meaningful in the demo Performance tab.
    const productCount = (db.prepare(`SELECT COUNT(*) AS n FROM products`).get() as any).n;
    if (productCount === 0) {
      const products = [
        { sku: 'COKE-15',  name: 'Coca-Cola 1.5L',   cat: 'soft drink', cost:  450, walk:  800, whole:  700, route:  680 },
        { sku: 'SPR-15',   name: 'Sprite 1.5L',      cat: 'soft drink', cost:  450, walk:  800, whole:  700, route:  680 },
        { sku: 'FAN-15',   name: 'Fanta Orange 1.5L',cat: 'soft drink', cost:  450, walk:  800, whole:  700, route:  680 },
        { sku: 'VOL-075',  name: 'Voltic 750ml',     cat: 'water',      cost:  150, walk:  300, whole:  250, route:  240 },
        { sku: 'BEL-075',  name: 'Bel-Aqua 750ml',   cat: 'water',      cost:  140, walk:  280, whole:  230, route:  220 },
        { sku: 'CLUB-33',  name: 'Club Beer 330ml',  cat: 'beer',       cost:  600, walk: 1100, whole:  950, route:  920 },
        { sku: 'STAR-33',  name: 'Star Beer 330ml',  cat: 'beer',       cost:  600, walk: 1100, whole:  950, route:  920 },
        { sku: 'GUIN-33',  name: 'Guinness FES 330ml',cat: 'beer',      cost:  900, walk: 1500, whole: 1300, route: 1260 },
      ];
      const stmt = db.prepare(
        `INSERT INTO products
           (id, sku, name, category, pack_size_units, unit_volume_ml,
            cost_price_pesewas, walk_in_price_pesewas, wholesale_price_pesewas,
            route_price_pesewas, reorder_threshold, reorder_quantity,
            count_class, created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 24, 120, 'A', ?, ?, ?)`,
      );
      for (const p of products) {
        stmt.run(
          `prod-${uuidv4()}`, p.sku, p.name, p.cat, 1500,
          p.cost, p.walk, p.whole, p.route,
          ownerId, ownerId, deviceId,
        );
      }
      seeded = true;
    }

    // Customers.
    const customerCount = (db.prepare(`SELECT COUNT(*) AS n FROM customers`).get() as any).n;
    if (customerCount === 0) {
      const customers = [
        { name: 'Mama Akua',   phone: '+233244111222', type: 'WHOLESALE', limit: 200000 },
        { name: 'Bro Kojo',    phone: '+233244111333', type: 'ROUTE',     limit: 150000 },
        { name: 'Auntie Esi',  phone: '+233244111444', type: 'WALK_IN',   limit: 0 },
      ];
      const stmt = db.prepare(
        `INSERT INTO customers
           (id, display_name, phone, customer_type,
            credit_limit_pesewas, preferred_channel,
            created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of customers) {
        stmt.run(
          `cust-${uuidv4()}`, c.name, c.phone, c.type,
          c.limit, c.type,
          ownerId, ownerId, deviceId,
        );
      }
      seeded = true;
    }

    // Wave H thresholds — uses upsertThreshold under the hood.
    ensureLoyaltyDefaults(db, ownerId, deviceId);
  });
  tx();

  return { ownerId: ownerId!, locationId: locationId!, seeded };
}

export const DEMO_PIN_FOR_HUMANS = DEMO_OWNER_PIN;
