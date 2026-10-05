import { Inject, Injectable } from '@nestjs/common';
import {
  addQuantity,
  type BatchStockPage,
  type ReorderLevelInput,
  type ReorderPage,
  shiftIsoDate,
  type StockCard,
  type StockFilter,
  type StockItem,
  type StockMovementPage,
  type StockPage,
  todayIn,
} from '@omnivo/contracts';
import {
  batches,
  products,
  productVariants,
  reorderLevels,
  serials,
  stockBalances,
  stockMovements,
  stockTransferLines,
  stockTransfers,
  tenantSettings,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, gt, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, diff } from '../common/audit/audit.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { decodeCursor, encodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// Postgres's NUMERIC as the API sends every quantity: 4 decimals, "0.0000" for nothing
function quantityText(value: SQL): SQL<string> {
  return sql<string>`round(coalesce(${value}, 0), 4)::text`;
}

// LIKE's own wildcards in what the person typed are meant literally (as in the product list)
function containsPattern(search: string): string {
  return `%${search.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const unitsSchema = z.array(z.object({ unitId: z.uuid(), factor: z.string() }));

const itemRowSchema = z.object({
  variant_id: z.uuid(),
  product_id: z.uuid(),
  product_code: z.string(),
  product_name: z.string(),
  option_values: z.array(z.string()),
  sku: z.string(),
  base_unit_id: z.uuid(),
  tracking: z.string(),
  has_expiry: z.boolean(),
  // postgres.js parses json; a driver that does not would hand over the text
  units: z.union([
    unitsSchema,
    z
      .string()
      .transform((text): unknown => JSON.parse(text))
      .pipe(unitsSchema),
  ]),
  archived: z.boolean(),
  on_hand: z.string(),
  in_transit: z.string(),
  low: z.boolean(),
  sort_key: z.string(),
  position: z.number().int(),
});

function toItem(row: z.output<typeof itemRowSchema>): StockItem {
  return {
    variantId: row.variant_id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    optionValues: row.option_values,
    sku: row.sku,
    baseUnitId: row.base_unit_id,
    tracking: row.tracking,
    hasExpiry: row.has_expiry,
    units: row.units,
    archived: row.archived,
    onHand: row.on_hand,
    inTransit: row.in_transit,
    low: row.low,
  };
}

const listCursorSchema = z.tuple([z.string(), z.uuid(), z.number().int()]);
const movementCursorSchema = z.tuple([z.iso.date(), z.uuid()]);
// A batch without an expiry sorts last: 9999-12-31 stands for "never"
const NEVER = '9999-12-31';
const batchCursorSchema = z.tuple([z.iso.date(), z.uuid(), z.uuid()]);
const reorderCursorSchema = z.tuple([z.string(), z.uuid(), z.uuid()]);

const batchRowSchema = z.object({
  batch_id: z.uuid(),
  lot_number: z.string(),
  manufactured_on: z.iso.date().nullable(),
  expires_on: z.iso.date().nullable(),
  warehouse_id: z.uuid(),
  quantity: z.string(),
  variant_id: z.uuid(),
  product_id: z.uuid(),
  product_code: z.string(),
  product_name: z.string(),
  option_values: z.array(z.string()),
  sku: z.string(),
  base_unit_id: z.uuid(),
});

const reorderRowSchema = z.object({
  variant_id: z.uuid(),
  product_id: z.uuid(),
  product_code: z.string(),
  product_name: z.string(),
  option_values: z.array(z.string()),
  sku: z.string(),
  base_unit_id: z.uuid(),
  warehouse_id: z.uuid(),
  on_hand: z.string(),
  in_transit: z.string(),
  min_quantity: z.string(),
  reorder_quantity: z.string().nullable(),
  sort_key: z.string(),
});

// Reading stock: every query here reads stock_balances (what is there now) and stock_movements
// (how it got there) — never a quantity stored on a product.
@Injectable()
export class StockService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    search?: string | undefined;
    warehouseId?: string | undefined;
    categoryId?: string | undefined;
    filter: StockFilter;
  }): Promise<StockPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, listCursorSchema);
    const conditions: SQL[] = [
      // Archived products and variants drop out of the list once they hold nothing
      sql`((p.archived_at IS NULL AND v.archived_at IS NULL) OR coalesce(s.on_hand, 0) <> 0)`,
    ];
    if (query.filter === 'in_stock') conditions.push(sql`coalesce(s.on_hand, 0) > 0`);
    if (query.filter === 'low') conditions.push(lowCondition(query.warehouseId));
    if (query.categoryId !== undefined) {
      // The category and everything under it, like the product list
      conditions.push(sql`p.category_id IN (
        WITH RECURSIVE down AS (
          SELECT id FROM product_categories WHERE tenant_id = ${tenantId}::uuid AND id = ${query.categoryId}::uuid
          UNION ALL
          SELECT c.id FROM product_categories c JOIN down ON c.parent_id = down.id
           WHERE c.tenant_id = ${tenantId}::uuid
        ) SELECT id FROM down)`);
    }
    if (query.search !== undefined && query.search !== '') {
      const pattern = containsPattern(query.search);
      // A barcode and a serial number are matched whole: a scan into the search box finds the
      // variant itself, not every product of the style
      conditions.push(sql`(
        lower(p.name) LIKE ${pattern} OR lower(p.code) LIKE ${pattern} OR lower(v.sku) LIKE ${pattern}
        OR EXISTS (SELECT 1 FROM product_barcodes b
                    WHERE b.tenant_id = v.tenant_id AND b.variant_id = v.id AND b.code = ${query.search})
        OR EXISTS (SELECT 1 FROM serials sr
                    WHERE sr.tenant_id = v.tenant_id AND sr.variant_id = v.id AND sr.serial_number = ${query.search}))`);
    }
    if (after !== undefined) {
      conditions.push(
        sql`(lower(p.name), p.id, v.position) > (${after[0]}, ${after[1]}::uuid, ${after[2]}::int)`,
      );
    }
    return this.withTenant(async (tx) => {
      const rows = await this.items(tx, conditions, query.warehouseId, query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toItem),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor([last.sort_key, last.product_id, last.position])
            : null,
      };
    });
  }

  card(variantId: string): Promise<StockCard> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [row] = await this.items(tx, [sql`v.id = ${variantId}::uuid`], undefined, 1);
      if (!row) throw notFound('Variant');

      const balance = sql<string>`(SELECT sum(sb.quantity) FROM stock_balances sb
        WHERE sb.tenant_id = w.tenant_id AND sb.warehouse_id = w.id AND sb.variant_id = ${variantId}::uuid)`;
      const places = z
        .array(
          z.object({
            warehouse_id: z.uuid(),
            on_hand: z.string(),
            in_transit: z.string(),
            min_quantity: z.string().nullable(),
            reorder_quantity: z.string().nullable(),
          }),
        )
        .parse(
          await tx.execute(sql`
            SELECT w.id::text AS warehouse_id, ${quantityText(balance)} AS on_hand,
                   ${quantityText(sql`(SELECT sum(l.base_quantity) FROM stock_transfer_lines l
                      JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
                     WHERE l.tenant_id = w.tenant_id AND l.variant_id = ${variantId}::uuid
                       AND t.status = 'in_transit' AND t.to_warehouse_id = w.id)`)} AS in_transit,
                   r.min_quantity::text AS min_quantity, r.reorder_quantity::text AS reorder_quantity
              FROM warehouses w
              LEFT JOIN reorder_levels r
                ON r.tenant_id = w.tenant_id AND r.warehouse_id = w.id AND r.variant_id = ${variantId}::uuid
             WHERE w.tenant_id = ${tenantId}::uuid
               AND (w.archived_at IS NULL OR coalesce(${balance}, 0) <> 0)
             ORDER BY w.code`),
        );

      // FEFO: the batch that expires first is used first; no expiry goes last
      const batchRows = await tx
        .select({
          batchId: batches.id,
          lotNumber: batches.lotNumber,
          manufacturedOn: batches.manufacturedOn,
          expiresOn: batches.expiresOn,
          warehouseId: stockBalances.warehouseId,
          quantity: stockBalances.quantity,
        })
        .from(stockBalances)
        .innerJoin(
          batches,
          and(eq(batches.tenantId, stockBalances.tenantId), eq(batches.id, stockBalances.batchId)),
        )
        .where(
          and(
            eq(stockBalances.tenantId, tenantId),
            eq(stockBalances.variantId, variantId),
            gt(stockBalances.quantity, '0'),
          ),
        )
        .orderBy(
          sql`${batches.expiresOn} ASC NULLS LAST`,
          sql`lower(${batches.lotNumber})`,
          asc(stockBalances.warehouseId),
        );

      const inStock = await tx
        .select({ serialNumber: serials.serialNumber, warehouseId: serials.warehouseId })
        .from(serials)
        .where(
          and(
            eq(serials.tenantId, tenantId),
            eq(serials.variantId, variantId),
            isNotNull(serials.warehouseId),
          ),
        )
        .orderBy(asc(serials.serialNumber));
      const travelling = await tx
        .select({ serialNumbers: stockTransferLines.serialNumbers })
        .from(stockTransferLines)
        .innerJoin(
          stockTransfers,
          and(
            eq(stockTransfers.tenantId, stockTransferLines.tenantId),
            eq(stockTransfers.id, stockTransferLines.transferId),
          ),
        )
        .where(
          and(
            eq(stockTransferLines.tenantId, tenantId),
            eq(stockTransferLines.variantId, variantId),
            eq(stockTransfers.status, 'in_transit'),
          ),
        );

      return {
        item: toItem(row),
        warehouses: places.map((place) => ({
          warehouseId: place.warehouse_id,
          onHand: place.on_hand,
          inTransit: place.in_transit,
          minQuantity: place.min_quantity,
          reorderQuantity: place.reorder_quantity,
        })),
        batches: batchRows,
        serials: [
          ...inStock,
          ...travelling
            .flatMap((line) => line.serialNumbers)
            .sort()
            .map((serialNumber) => ({ serialNumber, warehouseId: null })),
        ],
      };
    });
  }

  // The stock card's history, like an account's ledger (LedgerService): in date order, with a
  // running balance that continues from page to page, an opening balance before `from` and a
  // closing balance up to `to`
  movements(
    variantId: string,
    query: {
      limit: number;
      cursor?: string | undefined;
      warehouseId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    },
  ): Promise<StockMovementPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, movementCursorSchema);
    return this.withTenant(async (tx) => {
      const [variant] = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.id, variantId)));
      if (!variant) throw notFound('Variant');

      const scope = and(
        eq(stockMovements.tenantId, tenantId),
        eq(stockMovements.variantId, variantId),
        query.warehouseId === undefined
          ? undefined
          : eq(stockMovements.warehouseId, query.warehouseId),
      );
      const position = sql`(${stockMovements.date}, ${stockMovements.id})`;
      const beforeFrom =
        query.from === undefined ? undefined : sql`${stockMovements.date} < ${query.from}::date`;

      const rows = await tx
        .select({
          id: stockMovements.id,
          date: stockMovements.date,
          warehouseId: stockMovements.warehouseId,
          kind: stockMovements.kind,
          documentId: stockMovements.documentId,
          documentNumber: stockMovements.documentNumber,
          quantity: stockMovements.quantity,
          lotNumber: batches.lotNumber,
          serialNumber: serials.serialNumber,
        })
        .from(stockMovements)
        .leftJoin(
          batches,
          and(
            eq(batches.tenantId, stockMovements.tenantId),
            eq(batches.id, stockMovements.batchId),
          ),
        )
        .leftJoin(
          serials,
          and(
            eq(serials.tenantId, stockMovements.tenantId),
            eq(serials.id, stockMovements.serialId),
          ),
        )
        .where(
          and(
            scope,
            query.from === undefined
              ? undefined
              : sql`${stockMovements.date} >= ${query.from}::date`,
            query.to === undefined ? undefined : sql`${stockMovements.date} <= ${query.to}::date`,
            after === undefined
              ? undefined
              : sql`${position} > (${after[0]}::date, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(asc(stockMovements.date), asc(stockMovements.id))
        .limit(query.limit + 1);

      const sumWhere = (condition: SQL | undefined) =>
        quantityText(sql`sum(${stockMovements.quantity}) FILTER (WHERE ${condition ?? sql`true`})`);
      const [sums] = await tx
        .select({
          beforePage: sumWhere(
            after === undefined
              ? (beforeFrom ?? sql`false`)
              : sql`${position} <= (${after[0]}::date, ${after[1]}::uuid)`,
          ),
          opening: sumWhere(beforeFrom ?? sql`false`),
          closing: sumWhere(
            query.to === undefined ? undefined : sql`${stockMovements.date} <= ${query.to}::date`,
          ),
        })
        .from(stockMovements)
        .where(scope);
      if (!sums) throw new Error('Stock card sums returned no row');

      const page = toPage(rows, query.limit, (last) => [last.date, last.id]);
      let balance = sums.beforePage;
      return {
        items: page.items.map((row) => {
          balance = addQuantity(balance, row.quantity);
          return { ...row, balance };
        }),
        nextCursor: page.nextCursor,
        openingBalance: sums.opening,
        closingBalance: sums.closing,
      };
    });
  }

  // The expiry report: every batch with stock, the soonest expiry first — expired ones on top
  batches(query: {
    limit: number;
    cursor?: string | undefined;
    warehouseId?: string | undefined;
    expiresWithin?: number | undefined;
  }): Promise<BatchStockPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, batchCursorSchema);
    return this.withTenant(async (tx) => {
      const conditions: SQL[] = [sql`sb.tenant_id = ${tenantId}::uuid`, sql`sb.quantity > 0`];
      if (query.warehouseId !== undefined) {
        conditions.push(sql`sb.warehouse_id = ${query.warehouseId}::uuid`);
      }
      if (query.expiresWithin !== undefined) {
        // "Within 30 days" counts from today in the company's time zone, not the server's
        const until = shiftIsoDate(await this.today(tx), query.expiresWithin);
        conditions.push(sql`b.expires_on <= ${until}::date`);
      }
      const key = sql`coalesce(b.expires_on, ${NEVER}::date)`;
      if (after !== undefined) {
        conditions.push(
          sql`(${key}, b.id, sb.warehouse_id) > (${after[0]}::date, ${after[1]}::uuid, ${after[2]}::uuid)`,
        );
      }
      const rows = z.array(batchRowSchema).parse(
        await tx.execute(sql`
          SELECT b.id::text AS batch_id, b.lot_number, b.manufactured_on::text AS manufactured_on,
                 b.expires_on::text AS expires_on, sb.warehouse_id::text AS warehouse_id,
                 round(sb.quantity, 4)::text AS quantity, v.id::text AS variant_id,
                 p.id::text AS product_id, p.code AS product_code, p.name AS product_name,
                 v.option_values, v.sku, p.base_unit_id::text AS base_unit_id
            FROM stock_balances sb
            JOIN batches b ON b.tenant_id = sb.tenant_id AND b.id = sb.batch_id
            JOIN product_variants v ON v.tenant_id = sb.tenant_id AND v.id = sb.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
           WHERE ${sql.join(conditions, sql` AND `)}
           ORDER BY ${key}, b.id, sb.warehouse_id
           LIMIT ${query.limit + 1}`),
      );
      const page = toPage(rows, query.limit, (last) => [
        last.expires_on ?? NEVER,
        last.batch_id,
        last.warehouse_id,
      ]);
      return {
        items: page.items.map((row) => ({
          batchId: row.batch_id,
          lotNumber: row.lot_number,
          manufacturedOn: row.manufactured_on,
          expiresOn: row.expires_on,
          warehouseId: row.warehouse_id,
          quantity: row.quantity,
          variantId: row.variant_id,
          productId: row.product_id,
          productCode: row.product_code,
          productName: row.product_name,
          optionValues: row.option_values,
          sku: row.sku,
          baseUnitId: row.base_unit_id,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  // What to order: every variant whose stock in a warehouse is at or below its level there
  reorder(query: {
    limit: number;
    cursor?: string | undefined;
    warehouseId?: string | undefined;
  }): Promise<ReorderPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, reorderCursorSchema);
    return this.withTenant(async (tx) => {
      const conditions: SQL[] = [
        sql`r.tenant_id = ${tenantId}::uuid`,
        sql`coalesce(s.on_hand, 0) <= r.min_quantity`,
        sql`p.archived_at IS NULL AND v.archived_at IS NULL`,
      ];
      if (query.warehouseId !== undefined) {
        conditions.push(sql`r.warehouse_id = ${query.warehouseId}::uuid`);
      }
      if (after !== undefined) {
        conditions.push(
          sql`(lower(p.name), v.id, r.warehouse_id) > (${after[0]}, ${after[1]}::uuid, ${after[2]}::uuid)`,
        );
      }
      const rows = z.array(reorderRowSchema).parse(
        await tx.execute(sql`
          SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
                 p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
                 r.warehouse_id::text AS warehouse_id, ${quantityText(sql`s.on_hand`)} AS on_hand,
                 ${quantityText(sql`(SELECT sum(l.base_quantity) FROM stock_transfer_lines l
                    JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
                   WHERE l.tenant_id = r.tenant_id AND l.variant_id = r.variant_id
                     AND t.status = 'in_transit' AND t.to_warehouse_id = r.warehouse_id)`)} AS in_transit,
                 round(r.min_quantity, 4)::text AS min_quantity,
                 round(r.reorder_quantity, 4)::text AS reorder_quantity,
                 lower(p.name) AS sort_key
            FROM reorder_levels r
            JOIN warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id AND w.archived_at IS NULL
            JOIN product_variants v ON v.tenant_id = r.tenant_id AND v.id = r.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            LEFT JOIN LATERAL (
              SELECT sum(sb.quantity) AS on_hand FROM stock_balances sb
               WHERE sb.tenant_id = r.tenant_id AND sb.warehouse_id = r.warehouse_id
                 AND sb.variant_id = r.variant_id
            ) s ON true
           WHERE ${sql.join(conditions, sql` AND `)}
           ORDER BY lower(p.name), v.id, r.warehouse_id
           LIMIT ${query.limit + 1}`),
      );
      const page = toPage(rows, query.limit, (last) => [
        last.sort_key,
        last.variant_id,
        last.warehouse_id,
      ]);
      return {
        items: page.items.map((row) => ({
          variantId: row.variant_id,
          productId: row.product_id,
          productCode: row.product_code,
          productName: row.product_name,
          optionValues: row.option_values,
          sku: row.sku,
          baseUnitId: row.base_unit_id,
          warehouseId: row.warehouse_id,
          onHand: row.on_hand,
          inTransit: row.in_transit,
          minQuantity: row.min_quantity,
          reorderQuantity: row.reorder_quantity,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  setReorderLevel(input: ReorderLevelInput) {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [variant] = await tx
        .select({ productId: products.id, type: products.type })
        .from(productVariants)
        .innerJoin(
          products,
          and(
            eq(products.tenantId, productVariants.tenantId),
            eq(products.id, productVariants.productId),
          ),
        )
        .where(
          and(eq(productVariants.tenantId, tenantId), eq(productVariants.id, input.variantId)),
        );
      if (variant?.type !== 'goods') {
        throw new AppError(409, 'stock_variant_invalid', 'Pick a stocked product.', {
          fieldErrors: { variantId: ['stock_variant_invalid'] },
        });
      }
      const [warehouse] = await tx
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(
          and(
            eq(warehouses.tenantId, tenantId),
            eq(warehouses.id, input.warehouseId),
            isNull(warehouses.archivedAt),
          ),
        );
      if (!warehouse) {
        throw new AppError(409, 'stock_warehouse_invalid', 'Pick an active warehouse.', {
          fieldErrors: { warehouseId: ['stock_warehouse_invalid'] },
        });
      }

      const key = and(
        eq(reorderLevels.tenantId, tenantId),
        eq(reorderLevels.warehouseId, input.warehouseId),
        eq(reorderLevels.variantId, input.variantId),
      );
      const [before] = await tx.select().from(reorderLevels).where(key).for('update');
      const result = {
        warehouseId: input.warehouseId,
        variantId: input.variantId,
        minQuantity: input.minQuantity,
        reorderQuantity: input.minQuantity === null ? null : input.reorderQuantity,
      };
      let id = before?.id;
      if (input.minQuantity === null) {
        if (before) await tx.delete(reorderLevels).where(key);
      } else {
        const [row] = await tx
          .insert(reorderLevels)
          .values({
            tenantId,
            warehouseId: input.warehouseId,
            productId: variant.productId,
            variantId: input.variantId,
            minQuantity: input.minQuantity,
            reorderQuantity: input.reorderQuantity,
            updatedBy: currentPrincipal().userId,
          })
          .onConflictDoUpdate({
            target: [reorderLevels.tenantId, reorderLevels.warehouseId, reorderLevels.variantId],
            set: {
              minQuantity: input.minQuantity,
              reorderQuantity: input.reorderQuantity,
              updatedAt: new Date(),
              updatedBy: currentPrincipal().userId,
            },
          })
          .returning({
            id: reorderLevels.id,
            minQuantity: reorderLevels.minQuantity,
            reorderQuantity: reorderLevels.reorderQuantity,
          });
        if (!row) throw new Error('Reorder level upsert returned no row');
        id = row.id;
        result.minQuantity = row.minQuantity;
        result.reorderQuantity = row.reorderQuantity;
      }
      // Clearing a level that was never set changes nothing, and logs nothing
      if (id !== undefined) {
        await audit(tx, {
          action: 'reorder_level.changed',
          entityType: 'reorder_level',
          entityId: id,
          changes: diff(
            { min: before?.minQuantity ?? null, reorder: before?.reorderQuantity ?? null },
            { min: result.minQuantity, reorder: result.reorderQuantity },
          ),
        });
      }
      return result;
    });
  }

  // One query for the list and the card: the variant, its product, its packs, and its stock in
  // the chosen warehouse (or all of them)
  private async items(
    tx: Transaction,
    conditions: readonly SQL[],
    warehouseId: string | undefined,
    limit: number,
  ) {
    const tenantId = getTenantId();
    const inWarehouse = (column: SQL) =>
      warehouseId === undefined ? sql`true` : sql`${column} = ${warehouseId}::uuid`;
    return z.array(itemRowSchema).parse(
      await tx.execute(sql`
        SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
               p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
               p.tracking, p.has_expiry,
               coalesce((SELECT json_agg(json_build_object('unitId', pu.unit_id, 'factor', pu.factor::text)
                                         ORDER BY pu.position)
                           FROM product_units pu
                          WHERE pu.tenant_id = p.tenant_id AND pu.product_id = p.id), '[]'::json) AS units,
               (p.archived_at IS NOT NULL OR v.archived_at IS NOT NULL) AS archived,
               ${quantityText(sql`s.on_hand`)} AS on_hand,
               ${quantityText(sql`(SELECT sum(l.base_quantity) FROM stock_transfer_lines l
                  JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
                 WHERE l.tenant_id = v.tenant_id AND l.variant_id = v.id AND t.status = 'in_transit'
                   AND ${inWarehouse(sql`t.to_warehouse_id`)})`)} AS in_transit,
               ${lowCondition(warehouseId)} AS low,
               lower(p.name) AS sort_key, v.position::int AS position
          FROM product_variants v
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          LEFT JOIN LATERAL (
            SELECT sum(sb.quantity) AS on_hand FROM stock_balances sb
             WHERE sb.tenant_id = v.tenant_id AND sb.variant_id = v.id
               AND ${inWarehouse(sql`sb.warehouse_id`)}
          ) s ON true
         WHERE v.tenant_id = ${tenantId}::uuid AND p.type = 'goods'
           AND ${sql.join([...conditions], sql` AND `)}
         ORDER BY lower(p.name), p.id, v.position
         LIMIT ${limit}`),
    );
  }

  private async today(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    return todayIn(settings?.timezone ?? 'Asia/Dhaka');
  }
}

// At or below the reorder level in the chosen warehouse, or in any active warehouse
function lowCondition(warehouseId: string | undefined): SQL {
  return sql`EXISTS (
    SELECT 1 FROM reorder_levels r
      JOIN warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id AND w.archived_at IS NULL
     WHERE r.tenant_id = v.tenant_id AND r.variant_id = v.id
       AND ${warehouseId === undefined ? sql`true` : sql`r.warehouse_id = ${warehouseId}::uuid`}
       AND coalesce((SELECT sum(sb.quantity) FROM stock_balances sb
                      WHERE sb.tenant_id = r.tenant_id AND sb.warehouse_id = r.warehouse_id
                        AND sb.variant_id = r.variant_id), 0) <= r.min_quantity)`;
}
