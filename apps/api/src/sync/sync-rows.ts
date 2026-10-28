import {
  priceListItemKey,
  stockKey,
  type SyncCategory,
  type SyncCustomerGroup,
  type SyncEntity,
  type SyncPriceList,
  type SyncUpsert,
} from '@omnivo/contracts';
import {
  customerGroups,
  parties,
  posRegisters,
  priceLists,
  productCategories,
  products,
  taxRates,
  tenantSettings,
  tenants,
  units,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { Transaction } from '../common/tenant/with-tenant.js';
import { toWarehouse } from '../inventory/warehouses.service.js';
import { toSyncPosRegister } from '../pos/pos-registers.service.js';
import { productsOf } from '../products/product-read.js';
import { toUnit } from '../products/units.service.js';
import { customersOf } from '../sales/customer-read.js';
import { toTaxRate } from '../tax/tax-rates.service.js';

// What one device may keep, worked out once per page from its row (SyncService)
export interface SyncScope {
  tenantId: string;
  // The device's branch (decision 9)
  branchId: string;
  // Its active warehouses: the ones the device keeps, with their stock
  warehouseIds: string[];
}

// Which rows a loader reads:
//   keys  the rows the change log named (a delta pull). A key whose row is gone, or no longer in
//         the scope, is simply not in the answer; SyncService sends it as a delete.
//   page  the rows after `after` in key order, at most `limit` (a full pull)
export type SyncPick =
  { by: 'keys'; keys: string[] } | { by: 'page'; after: (string | null)[] | null; limit: number };

// A row as the pull sends it, and its key columns: the full pull's cursor continues after them
export interface SyncLoaded {
  change: SyncUpsert;
  sort: (string | null)[];
}

type Loader = (tx: Transaction, scope: SyncScope, pick: SyncPick) => Promise<SyncLoaded[]>;

// The tables keyed by their own id: by the keys, or the next page in id order. In keys mode the
// limit is the number of keys: one row per id at most.
function byId(id: PgColumn, pick: SyncPick): { where: SQL | undefined; limit: number } {
  if (pick.by === 'keys') return { where: inArray(id, pick.keys), limit: pick.keys.length };
  const after = pick.after?.[0];
  return { where: after == null ? undefined : gt(id, after), limit: pick.limit };
}

// Timestamps of a raw query as ISO text, like ProductsService's list: Drizzle leaves them as
// Postgres's own text there, which is not ISO
function isoText(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

// A key the log wrote with sync_price_key() / sync_stock_key(): ids joined by ':'. A key of
// another shape cannot come from those functions; it is skipped rather than sent to SQL.
const uuidSchema = z.uuid();
function splitKey(key: string, parts: number): string[] | null {
  const ids = key.split(':');
  return ids.length === parts ? ids : null;
}

// A stock row without a batch: '-' in its key, NULL in the table. In the full pull's order (and
// in its cursor) it sorts as the nil uuid, before every batch of the variant: a row comparison
// with NULL is never true, so `(…, batch_id) > (…)` alone would loop on that row.
const NO_BATCH = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

const priceRowSchema = z.object({
  price_list_id: z.uuid(),
  product_id: z.uuid(),
  variant_id: z.uuid(),
  unit_id: z.uuid(),
  price: z.string(),
  updated_at: z.iso.datetime(),
});

const stockRowSchema = z.object({
  warehouse_id: z.uuid(),
  product_id: z.uuid(),
  variant_id: z.uuid(),
  batch_id: z.uuid().nullable(),
  lot_number: z.string().nullable(),
  manufactured_on: z.iso.date().nullable(),
  expires_on: z.iso.date().nullable(),
  quantity: z.string(),
  updated_at: z.iso.datetime(),
});

// One loader per entity. Each applies the scope of 18a.2's facts, in both modes, so a delta and a
// full pull can never disagree on what a device keeps:
//   settings, units, categories, VAT rates, price lists, groups  all of them (archived ones too:
//                       a product or a customer may still point at one)
//   warehouse           active, of the device's branch
//   product             active
//   price_list_item     its product active and its list active (decision 27)
//   customer            a customer (not only a supplier), active
//   stock               in an active warehouse of the branch, not zero, its product active
//   pos_register        active, its warehouse in the device's branch (step 20a)
export const LOADERS: Record<SyncEntity, Loader> = {
  // One row, keyed by the workspace's id (the contract's settings key)
  settings: async (tx, scope, pick) => {
    const wanted = pick.by === 'keys' ? pick.keys.includes(scope.tenantId) : pick.after === null;
    if (!wanted) return [];
    const [row] = await tx
      .select({ settings: tenantSettings, companyName: tenants.name })
      .from(tenantSettings)
      .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
      .where(eq(tenantSettings.tenantId, scope.tenantId));
    if (!row) return [];
    const { settings } = row;
    return [
      {
        sort: [scope.tenantId],
        change: {
          op: 'upsert',
          entity: 'settings',
          key: scope.tenantId,
          data: {
            companyName: row.companyName,
            legalName: settings.legalName,
            bin: settings.bin,
            phone: settings.phone,
            address: settings.address,
            baseCurrency: settings.baseCurrency,
            fiscalYearStartMonth: settings.fiscalYearStartMonth,
            timezone: settings.timezone,
            allowNegativeStock: settings.allowNegativeStock,
            pricesIncludeVat: settings.pricesIncludeVat,
            version: settings.version,
          },
        },
      },
    ];
  },

  unit: async (tx, scope, pick) => {
    const { where, limit } = byId(units.id, pick);
    const rows = await tx
      .select()
      .from(units)
      .where(and(eq(units.tenantId, scope.tenantId), where))
      .orderBy(asc(units.id))
      .limit(limit);
    return rows.map((row) => ({
      sort: [row.id],
      change: { op: 'upsert', entity: 'unit', key: row.id, data: toUnit(row) },
    }));
  },

  // Without productCount (decision 15): the device counts what it needs itself
  product_category: async (tx, scope, pick) => {
    const { where, limit } = byId(productCategories.id, pick);
    const rows = await tx
      .select()
      .from(productCategories)
      .where(and(eq(productCategories.tenantId, scope.tenantId), where))
      .orderBy(asc(productCategories.id))
      .limit(limit);
    return rows.map((row) => {
      const data: SyncCategory = {
        id: row.id,
        parentId: row.parentId,
        name: row.name,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      };
      return {
        sort: [row.id],
        change: { op: 'upsert', entity: 'product_category', key: row.id, data },
      };
    });
  },

  tax_rate: async (tx, scope, pick) => {
    const { where, limit } = byId(taxRates.id, pick);
    const rows = await tx
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.tenantId, scope.tenantId), where))
      .orderBy(asc(taxRates.id))
      .limit(limit);
    return rows.map((row) => ({
      sort: [row.id],
      change: { op: 'upsert', entity: 'tax_rate', key: row.id, data: toTaxRate(row) },
    }));
  },

  warehouse: async (tx, scope, pick) => {
    const { where, limit } = byId(warehouses.id, pick);
    const rows = await tx
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.tenantId, scope.tenantId),
          eq(warehouses.branchId, scope.branchId),
          isNull(warehouses.archivedAt),
          where,
        ),
      )
      .orderBy(asc(warehouses.id))
      .limit(limit);
    return rows.map((row) => ({
      sort: [row.id],
      change: { op: 'upsert', entity: 'warehouse', key: row.id, data: toWarehouse(row) },
    }));
  },

  // Step 20a (decision 20): the registers of the branch, active ones, without the last number. The
  // branch is the warehouse's, so the join decides it: a register whose warehouse moved to another
  // branch drops out here (0052 logs it). Its warehouse may be archived: the register still is the
  // branch's, and the device keeps it.
  pos_register: async (tx, scope, pick) => {
    const { where, limit } = byId(posRegisters.id, pick);
    const rows = await tx
      .select({ register: posRegisters, branchId: warehouses.branchId })
      .from(posRegisters)
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, posRegisters.tenantId),
          eq(warehouses.id, posRegisters.warehouseId),
        ),
      )
      .where(
        and(
          eq(posRegisters.tenantId, scope.tenantId),
          eq(warehouses.branchId, scope.branchId),
          isNull(posRegisters.archivedAt),
          where,
        ),
      )
      .orderBy(asc(posRegisters.id))
      .limit(limit);
    return rows.map((row) => ({
      sort: [row.register.id],
      change: {
        op: 'upsert',
        entity: 'pos_register',
        key: row.register.id,
        data: toSyncPosRegister(row.register, row.branchId),
      },
    }));
  },

  // Without itemCount and customerCount (decision 15)
  price_list: async (tx, scope, pick) => {
    const { where, limit } = byId(priceLists.id, pick);
    const rows = await tx
      .select()
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, scope.tenantId), where))
      .orderBy(asc(priceLists.id))
      .limit(limit);
    return rows.map((row) => {
      const data: SyncPriceList = {
        id: row.id,
        name: row.name,
        description: row.description,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      };
      return { sort: [row.id], change: { op: 'upsert', entity: 'price_list', key: row.id, data } };
    });
  },

  // Without customerCount (decision 15)
  customer_group: async (tx, scope, pick) => {
    const { where, limit } = byId(customerGroups.id, pick);
    const rows = await tx
      .select()
      .from(customerGroups)
      .where(and(eq(customerGroups.tenantId, scope.tenantId), where))
      .orderBy(asc(customerGroups.id))
      .limit(limit);
    return rows.map((row) => {
      const data: SyncCustomerGroup = {
        id: row.id,
        name: row.name,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      };
      return {
        sort: [row.id],
        change: { op: 'upsert', entity: 'customer_group', key: row.id, data },
      };
    });
  },

  // A product with its variants (archived ones too: an old order line still names one), packs and
  // barcodes, built by the same productsOf() as the product page
  product: async (tx, scope, pick) => {
    const { where, limit } = byId(products.id, pick);
    const rows = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, scope.tenantId), isNull(products.archivedAt), where))
      .orderBy(asc(products.id))
      .limit(limit);
    const whole = await productsOf(tx, rows);
    return whole.map((data) => ({
      sort: [data.id],
      change: { op: 'upsert', entity: 'product', key: data.id, data },
    }));
  },

  // Raw SQL: two joins for the scope, and a row comparison on the primary key's columns, which
  // price_list_items_pkey (tenant, list, variant, unit) serves in both modes
  price_list_item: async (tx, scope, pick) => {
    let filter: SQL;
    let limit: number;
    if (pick.by === 'keys') {
      const tuples = pick.keys.flatMap((key) => {
        const ids = splitKey(key, 3);
        return ids?.every((id) => uuidSchema.safeParse(id).success) ? [ids] : [];
      });
      if (tuples.length === 0) return [];
      filter = sql`(i.price_list_id, i.variant_id, i.unit_id) IN (${sql.join(
        tuples.map(
          ([list, variant, unit]) => sql`(${list}::uuid, ${variant}::uuid, ${unit}::uuid)`,
        ),
        sql`, `,
      )})`;
      limit = tuples.length;
    } else {
      const [list, variant, unit] = pick.after ?? [];
      filter =
        list == null
          ? sql`true`
          : sql`(i.price_list_id, i.variant_id, i.unit_id) > (${list}::uuid, ${variant}::uuid, ${unit}::uuid)`;
      limit = pick.limit;
    }
    const rows = z.array(priceRowSchema).parse(
      await tx.execute(sql`
        SELECT i.price_list_id::text, i.product_id::text, i.variant_id::text, i.unit_id::text,
               i.price::text, ${isoText(sql`i.updated_at`)} AS updated_at
          FROM price_list_items i
          JOIN products p ON p.tenant_id = i.tenant_id AND p.id = i.product_id
          JOIN price_lists l ON l.tenant_id = i.tenant_id AND l.id = i.price_list_id
         WHERE i.tenant_id = ${scope.tenantId}::uuid
           AND p.archived_at IS NULL AND l.archived_at IS NULL
           AND ${filter}
         ORDER BY i.price_list_id, i.variant_id, i.unit_id
         LIMIT ${limit}`),
    );
    return rows.map((row) => {
      const data = {
        priceListId: row.price_list_id,
        productId: row.product_id,
        variantId: row.variant_id,
        unitId: row.unit_id,
        price: row.price,
        updatedAt: row.updated_at,
      };
      return {
        sort: [row.price_list_id, row.variant_id, row.unit_id],
        change: { op: 'upsert', entity: 'price_list_item', key: priceListItemKey(data), data },
      };
    });
  },

  customer: async (tx, scope, pick) => {
    const { where, limit } = byId(parties.id, pick);
    const rows = await tx
      .select()
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, scope.tenantId),
          eq(parties.isCustomer, true),
          isNull(parties.archivedAt),
          where,
        ),
      )
      .orderBy(asc(parties.id))
      .limit(limit);
    const whole = await customersOf(tx, rows);
    return whole.map((data) => ({
      sort: [data.id],
      change: { op: 'upsert', entity: 'customer', key: data.id, data },
    }));
  },

  // In keys mode the batch is compared with IS NOT DISTINCT FROM ('-' = no batch = NULL); the
  // stock_balances_key index still finds the rows by warehouse and variant
  stock: async (tx, scope, pick) => {
    if (scope.warehouseIds.length === 0) return [];
    let filter: SQL;
    let limit: number;
    if (pick.by === 'keys') {
      const tuples = pick.keys.flatMap((key) => {
        const ids = splitKey(key, 3);
        if (!ids) return [];
        const [warehouse = '', variant = '', batch = ''] = ids;
        const valid =
          uuidSchema.safeParse(warehouse).success &&
          uuidSchema.safeParse(variant).success &&
          (batch === '-' || uuidSchema.safeParse(batch).success);
        return valid ? [{ warehouse, variant, batch: batch === '-' ? null : batch }] : [];
      });
      if (tuples.length === 0) return [];
      filter = sql`(${sql.join(
        tuples.map(
          ({ warehouse, variant, batch }) =>
            sql`(b.warehouse_id = ${warehouse}::uuid AND b.variant_id = ${variant}::uuid
                 AND b.batch_id IS NOT DISTINCT FROM ${batch}::uuid)`,
        ),
        sql` OR `,
      )})`;
      limit = tuples.length;
    } else {
      const [warehouse, variant, batch = null] = pick.after ?? [];
      filter =
        warehouse == null
          ? sql`true`
          : sql`(b.warehouse_id, b.variant_id, coalesce(b.batch_id, ${NO_BATCH}))
                  > (${warehouse}::uuid, ${variant}::uuid, coalesce(${batch}::uuid, ${NO_BATCH}))`;
      limit = pick.limit;
    }
    const rows = z.array(stockRowSchema).parse(
      await tx.execute(sql`
        SELECT b.warehouse_id::text, b.product_id::text, b.variant_id::text, b.batch_id::text,
               t.lot_number, t.manufactured_on::text, t.expires_on::text, b.quantity::text,
               ${isoText(sql`b.updated_at`)} AS updated_at
          FROM stock_balances b
          JOIN products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
          LEFT JOIN batches t ON t.tenant_id = b.tenant_id AND t.id = b.batch_id
         WHERE b.tenant_id = ${scope.tenantId}::uuid
           AND b.warehouse_id IN (${sql.join(
             scope.warehouseIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
           AND b.quantity <> 0 AND p.archived_at IS NULL
           AND ${filter}
         ORDER BY b.warehouse_id, b.variant_id, coalesce(b.batch_id, ${NO_BATCH})
         LIMIT ${limit}`),
    );
    return rows.map((row) => {
      const data = {
        warehouseId: row.warehouse_id,
        productId: row.product_id,
        variantId: row.variant_id,
        batchId: row.batch_id,
        lotNumber: row.lot_number,
        manufacturedOn: row.manufactured_on,
        expiresOn: row.expires_on,
        quantity: row.quantity,
        updatedAt: row.updated_at,
      };
      return {
        sort: [row.warehouse_id, row.variant_id, row.batch_id],
        change: { op: 'upsert', entity: 'stock', key: stockKey(data), data },
      };
    });
  },
};
