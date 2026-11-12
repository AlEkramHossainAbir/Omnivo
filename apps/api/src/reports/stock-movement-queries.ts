import {
  MOVEMENT_KINDS,
  STOCK_MOVEMENT_COLUMN_OF,
  type StockMovementColumn,
  type StockMovementFilter,
  type StockMovementReport,
  type StockMovementSort,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import {
  inCategory,
  pageClause,
  pageRows,
  type ReportPage,
  select,
  sortColumn,
  type SortColumn,
} from './report-paging.js';

// The stock movement report (step 21c): per variant, in the base unit,
//   closing = opening + purchased − sold + transfers + adjusted
// Nothing new is stored for it (decision 5). What a variant holds now is kept by the database
// (stock_values for the whole company, stock_balances per warehouse), so:
//   opening = now − every movement dated from the first day on
//   closing = now − every movement dated after the last day
// That reads the movements from the first day to today, never the whole ledger
// (stock_movements_date_idx). The value works the same way, from stock_values' value, or, for
// one warehouse, from the sum of that warehouse's movement values (stock_values has no warehouse).

// The kinds of one column, from the contract's map. MOVEMENT_KINDS, not Object.keys: it keeps
// the type, and the map's satisfies already says every kind is in it.
function kindsOf(column: StockMovementColumn): SQL {
  const kinds = MOVEMENT_KINDS.filter((kind) => STOCK_MOVEMENT_COLUMN_OF[kind] === column);
  return sql`(${sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  )})`;
}

// The quantity of one column inside the period. "sold" is turned round: stock that left is a
// positive number there (a return comes back with the opposite sign, decision 21).
function columnSum(column: StockMovementColumn, to: string): SQL {
  const inPeriod = sql`m.date <= ${to}::date AND m.kind IN ${kindsOf(column)}`;
  const sum = sql`coalesce(sum(m.quantity) FILTER (WHERE ${inPeriod}), 0)`;
  return column === 'sold' ? sql`-${sum}` : sum;
}

// What each variant holds now, in the report's scope. With a warehouse filter the value is that
// warehouse's movements added up since the beginning: the one place this report reads old
// movements, and only for one warehouse and only when the value is shown.
function nowOf(tenantId: string, warehouseId: string | undefined, withValue: boolean): SQL {
  if (warehouseId === undefined) {
    return sql`SELECT sv.variant_id, sv.quantity, sv.value
                 FROM stock_values sv WHERE sv.tenant_id = ${tenantId}::uuid`;
  }
  const value = withValue
    ? sql`(SELECT coalesce(sum(x.value), 0) FROM stock_movements x
            WHERE x.tenant_id = b.tenant_id AND x.warehouse_id = b.warehouse_id
              AND x.variant_id = b.variant_id)`
    : sql`0::numeric`;
  // One balance row per batch: added up per variant first
  return sql`SELECT b.variant_id, sum(b.quantity) AS quantity, ${value} AS value
               FROM stock_balances b
              WHERE b.tenant_id = ${tenantId}::uuid AND b.warehouse_id = ${warehouseId}::uuid
              GROUP BY b.tenant_id, b.warehouse_id, b.variant_id`;
}

// After the sort's own column: the name in any case, then the product and the variant's place, so
// two products called "Napa" (or two rows with the same number) keep their order from page to page
const BY_NAME = sql`lower(p.name), p.id, v.position`;

const SORT_COLUMNS = {
  name: sql`lower(p.name)`,
  sku: sql`lower(v.sku)`,
  opening: sql`r.opening`,
  purchased: sql`r.purchased`,
  sold: sql`r.sold`,
  transfers: sql`r.transfers`,
  adjusted: sql`r.adjusted`,
  closing: sql`r.closing`,
  openingValue: sql`r.opening_value`,
  closingValue: sql`r.closing_value`,
} satisfies Record<SortColumn<StockMovementSort>, SQL>;

const rowSchema = z.object({
  variant_id: z.uuid(),
  product_id: z.uuid(),
  product_code: z.string(),
  product_name: z.string(),
  option_values: z.array(z.string()),
  sku: z.string(),
  base_unit_id: z.uuid(),
  unit_code: z.string(),
  unit_decimals: z.number().int(),
  opening: z.string(),
  purchased: z.string(),
  sold: z.string(),
  transfers: z.string(),
  adjusted: z.string(),
  closing: z.string(),
  opening_value: z.string(),
  closing_value: z.string(),
  total_variants: z.number().int(),
  total_opening_value: z.string(),
  total_closing_value: z.string(),
});

// The report, a page of rows (page) or every row (null, an export). Without withValue the value
// columns are null; the service refuses a value sort before it gets here (decision 24).
export async function stockMovementReport(
  tx: Transaction,
  filter: StockMovementFilter,
  options: { withValue: boolean; page: ReportPage | null },
): Promise<StockMovementReport> {
  const tenantId = getTenantId();
  const { from, to } = filter;
  const sort = sortColumn(filter.sort, SORT_COLUMNS);
  const where: SQL[] = [
    // decision 22: 'moved' = a movement in the period; 'all' adds what had stock at the start
    filter.show === 'moved' ? sql`r.moved` : sql`(r.moved OR r.opening <> 0)`,
  ];
  if (filter.categoryId !== undefined) {
    where.push(inCategory(sql`p.category_id`, tenantId, filter.categoryId));
  }
  const found = await select(
    tx,
    sql`WITH moves AS (
          SELECT m.variant_id,
                 sum(m.quantity) AS quantity_since, sum(m.value) AS value_since,
                 coalesce(sum(m.quantity) FILTER (WHERE m.date > ${to}::date), 0) AS quantity_after,
                 coalesce(sum(m.value) FILTER (WHERE m.date > ${to}::date), 0) AS value_after,
                 ${columnSum('purchased', to)} AS purchased,
                 ${columnSum('sold', to)} AS sold,
                 ${columnSum('transfers', to)} AS transfers,
                 ${columnSum('adjusted', to)} AS adjusted,
                 -- A revaluation counts: it moved the value
                 bool_or(m.date <= ${to}::date) AS moved
            FROM stock_movements m
           WHERE m.tenant_id = ${tenantId}::uuid AND m.date >= ${from}::date
             ${filter.warehouseId === undefined ? sql`` : sql`AND m.warehouse_id = ${filter.warehouseId}::uuid`}
           GROUP BY m.variant_id
        ),
        now AS (${nowOf(tenantId, filter.warehouseId, options.withValue)}),
        -- Every variant that moved has a row in now: the database adds each movement there
        rows AS (
          SELECT n.variant_id,
                 n.quantity - coalesce(mv.quantity_since, 0) AS opening,
                 coalesce(mv.purchased, 0) AS purchased, coalesce(mv.sold, 0) AS sold,
                 coalesce(mv.transfers, 0) AS transfers, coalesce(mv.adjusted, 0) AS adjusted,
                 n.quantity - coalesce(mv.quantity_after, 0) AS closing,
                 n.value - coalesce(mv.value_since, 0) AS opening_value,
                 n.value - coalesce(mv.value_after, 0) AS closing_value,
                 coalesce(mv.moved, false) AS moved
            FROM now n
            LEFT JOIN moves mv ON mv.variant_id = n.variant_id
        )
        SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
               p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
               u.code AS unit_code, u.decimals AS unit_decimals,
               round(r.opening, 4)::text AS opening, round(r.purchased, 4)::text AS purchased,
               round(r.sold, 4)::text AS sold, round(r.transfers, 4)::text AS transfers,
               round(r.adjusted, 4)::text AS adjusted, round(r.closing, 4)::text AS closing,
               round(r.opening_value, 4)::text AS opening_value,
               round(r.closing_value, 4)::text AS closing_value,
               -- Over every row, before the LIMIT: the same on every page
               (count(*) OVER ())::int AS total_variants,
               round(coalesce(sum(r.opening_value) OVER (), 0), 4)::text AS total_opening_value,
               round(coalesce(sum(r.closing_value) OVER (), 0), 4)::text AS total_closing_value
          FROM rows r
          JOIN product_variants v ON v.tenant_id = ${tenantId}::uuid AND v.id = r.variant_id
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
         WHERE ${sql.join(where, sql` AND `)}
         ORDER BY ${sort.column} ${sort.direction}, ${BY_NAME}
         ${pageClause(options.page)}`,
    rowSchema,
  );
  const first = found[0];
  const page = pageRows(found, options.page);
  const value = (amount: string): string | null => (options.withValue ? amount : null);
  return {
    items: page.items.map((row) => ({
      variantId: row.variant_id,
      productId: row.product_id,
      productCode: row.product_code,
      productName: row.product_name,
      optionValues: row.option_values,
      sku: row.sku,
      baseUnitId: row.base_unit_id,
      baseUnit: { code: row.unit_code, decimals: row.unit_decimals },
      opening: row.opening,
      purchased: row.purchased,
      sold: row.sold,
      transfers: row.transfers,
      adjusted: row.adjusted,
      closing: row.closing,
      openingValue: value(row.opening_value),
      closingValue: value(row.closing_value),
    })),
    nextCursor: page.nextCursor,
    withValue: options.withValue,
    totals: {
      variants: first?.total_variants ?? 0,
      openingValue: value(first?.total_opening_value ?? '0.0000'),
      closingValue: value(first?.total_closing_value ?? '0.0000'),
    },
  };
}
