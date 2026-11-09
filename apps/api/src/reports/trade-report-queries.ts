import {
  costColumns,
  type PurchaseReport,
  type PurchaseReportFilter,
  type PurchaseReportGroup,
  type PurchaseReportSort,
  type SalesReport,
  type SalesReportFilter,
  type SalesReportGroup,
  type SalesReportSort,
  TRADE_REPORT_ROW_KINDS,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { loadBooks } from '../dashboard/dashboard-queries.js';
import {
  inCategory,
  pageClause,
  pageRows,
  type ReportPage,
  select,
  sortColumn,
  type SortColumn,
} from './report-paging.js';

// The sales and purchase reports (step 21b), in plain SQL like the statements (report-queries.ts),
// so the API (a page) and the worker (an export) run the same queries. Each one is three steps:
// 1. `lines`: every line of the period, one row each, from every kind of document, signed so that
//    adding them up gives the period (a sale adds, a return takes off);
// 2. `grouped`: the lines added up per row of the report, with the filters;
// 3. the page: sorted, with the totals of every row from a window function (worked out before the
//    LIMIT, so they are the same on every page).
// Amounts come back as text with 4 places; the cost of a line from a challan or a return is
// rounded to 4 places line by line, so the rows add up to the totals to the paisa.

// The lines' common columns: tenant_id, day, the party, branch_id, variant_id, gross, returns and
// quantity, plus cost (sales) or account_id (purchases).

// ---------------------------------------------------------------------------------------------
// Sales

// Every sold and returned line of the period (decision 2), net of discounts and before VAT:
// - an invoice line, with the cost of its challan line in the share the invoice billed (a return
//   before billing makes the invoice bill less of the challan line);
// - a POS sale line, with its own cost; its branch is its warehouse's;
// - a credit note line takes its money off on the credit note's day, in the invoice's branch. Only a
//   line for goods that came back (a return line) takes the quantity and the cost off: a price cut
//   gives money back, not goods;
// - a POS return line takes off its money, quantity and cost on the return's day.
function salesLines(tenantId: string, from: string, to: string): SQL {
  return sql`
    SELECT l.tenant_id, i.date AS day, i.customer_id, i.branch_id, l.variant_id,
           l.net AS gross, 0::numeric AS returns, l.base_quantity AS quantity,
           coalesce(round(d.value * l.base_quantity / d.base_quantity, 4), 0) AS cost
      FROM invoice_lines l
      JOIN invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
      LEFT JOIN delivery_lines d ON d.tenant_id = l.tenant_id AND d.id = l.delivery_line_id
     WHERE l.tenant_id = ${tenantId}::uuid AND i.status = 'posted'
       AND i.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT l.tenant_id, s.date, s.customer_id, w.branch_id, l.variant_id,
           l.net, 0, l.base_quantity, l.value
      FROM pos_sale_lines l
      JOIN pos_sales s ON s.tenant_id = l.tenant_id AND s.id = l.sale_id
      JOIN warehouses w ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
     WHERE l.tenant_id = ${tenantId}::uuid AND s.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT l.tenant_id, c.date, c.customer_id, i.branch_id, l.variant_id,
           0, l.net,
           CASE WHEN r.id IS NULL THEN 0 ELSE -l.base_quantity END,
           CASE WHEN r.id IS NULL THEN 0 ELSE -round(r.value * l.base_quantity / r.base_quantity, 4) END
      FROM credit_note_lines l
      JOIN credit_notes c ON c.tenant_id = l.tenant_id AND c.id = l.credit_note_id
      JOIN invoices i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
      LEFT JOIN sales_return_lines r ON r.tenant_id = l.tenant_id AND r.id = l.return_line_id
     WHERE l.tenant_id = ${tenantId}::uuid AND c.status = 'posted'
       AND c.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT l.tenant_id, r.date, s.customer_id, w.branch_id, l.variant_id,
           0, l.net, -l.base_quantity, -l.value
      FROM pos_return_lines l
      JOIN pos_returns r ON r.tenant_id = l.tenant_id AND r.id = l.return_id
      JOIN pos_sales s ON s.tenant_id = r.tenant_id AND s.id = r.sale_id
      JOIN warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id
     WHERE l.tenant_id = ${tenantId}::uuid AND r.date BETWEEN ${from}::date AND ${to}::date`;
}

// What makes one row of each group: its key, kind, id, code, name and month, the joins it needs,
// and what it groups by. A row with no such thing (a walk-in, no category) has a kind of its own
// and its key is that kind (decision 16).
interface Grouping {
  select: SQL;
  joins: SQL;
  groupBy: SQL;
}

const SALES_GROUPINGS = {
  customer: {
    select: sql`coalesce(l.customer_id::text, 'walk_in') AS key,
                CASE WHEN l.customer_id IS NULL THEN 'walk_in' ELSE 'item' END AS kind,
                c.id::text AS id, c.code, c.name, NULL::text AS month`,
    joins: sql``,
    groupBy: sql`l.customer_id, c.id`,
  },
  product: {
    select: sql`p.id::text AS key, 'item' AS kind, p.id::text AS id, p.code, p.name,
                NULL::text AS month`,
    joins: sql``,
    groupBy: sql`p.id, u.id`,
  },
  category: {
    select: sql`coalesce(p.category_id::text, 'no_category') AS key,
                CASE WHEN p.category_id IS NULL THEN 'no_category' ELSE 'item' END AS kind,
                pc.id::text AS id, NULL::text AS code, pc.name, NULL::text AS month`,
    joins: sql`LEFT JOIN product_categories pc ON pc.tenant_id = p.tenant_id AND pc.id = p.category_id`,
    groupBy: sql`p.category_id, pc.id`,
  },
  branch: {
    select: sql`b.id::text AS key, 'item' AS kind, b.id::text AS id, b.code, b.name,
                NULL::text AS month`,
    joins: sql`JOIN branches b ON b.tenant_id = l.tenant_id AND b.id = l.branch_id`,
    groupBy: sql`b.id`,
  },
  month: {
    select: sql`to_char(l.day, 'YYYY-MM') AS key, 'item' AS kind, NULL::text AS id,
                NULL::text AS code, NULL::text AS name, to_char(l.day, 'YYYY-MM') AS month`,
    joins: sql``,
    groupBy: sql`to_char(l.day, 'YYYY-MM')`,
  },
} satisfies Record<SalesReportGroup, Grouping>;

// The sorts read the grouped rows by their alias, g. Written bare, ORDER BY net would sort by the
// SELECT's own column called net, which is text: "9000.0000" after "18000.0000".

// The name a row sorts by: a month by its date ('2026-09' sorts like the date), a thing by its
// name in any case. A row that is not an item has none and goes last, whichever way.
const SORT_NAME = sql`CASE WHEN g.kind = 'item' THEN coalesce(g.month, lower(g.name)) END`;

// Name, then key: two customers called "Sylhet Pharmacy" still come in the same order every time,
// so a page never repeats or skips one
function orderBy(sort: { column: SQL; direction: SQL }, byName: boolean): SQL {
  if (byName) return sql`${SORT_NAME} IS NULL, ${SORT_NAME} ${sort.direction}, g.key`;
  return sql`${sort.column} ${sort.direction} NULLS LAST, ${SORT_NAME} IS NULL, ${SORT_NAME}, g.key`;
}

const SALES_SORT_COLUMNS = {
  name: SORT_NAME,
  quantity: sql`g.quantity`,
  gross: sql`g.gross`,
  returns: sql`g.returns`,
  net: sql`g.net`,
  cost: sql`g.cost`,
  margin: sql`g.net - g.cost`,
  // A row with a net of zero has no percent: last, like a null
  marginPercent: sql`CASE WHEN g.net <> 0 THEN (g.net - g.cost) / g.net END`,
} satisfies Record<SortColumn<SalesReportSort>, SQL>;

const unitColumns = {
  unit_code: z.string().nullable(),
  unit_decimals: z.number().int().nullable(),
};

const tradeRowColumns = {
  key: z.string(),
  kind: z.enum(TRADE_REPORT_ROW_KINDS),
  id: z.uuid().nullable(),
  code: z.string().nullable(),
  name: z.string().nullable(),
  month: z.string().nullable(),
  quantity: z.string().nullable(),
  ...unitColumns,
  gross: z.string(),
  returns: z.string(),
  net: z.string(),
  total_gross: z.string(),
  total_returns: z.string(),
  total_net: z.string(),
};

const salesRowSchema = z.object({
  ...tradeRowColumns,
  cost: z.string(),
  total_cost: z.string(),
});

// The quantity and its unit belong to the product group only: elsewhere a row mixes units. A
// number here, so it sorts as one; text only in the last SELECT.
function quantityColumns(byProduct: boolean): SQL {
  return byProduct
    ? sql`sum(l.quantity) AS quantity, u.code AS unit_code, u.decimals AS unit_decimals`
    : sql`NULL::numeric AS quantity, NULL::text AS unit_code, NULL::int AS unit_decimals`;
}

function unitOf(row: { unit_code: string | null; unit_decimals: number | null }) {
  return row.unit_code === null || row.unit_decimals === null
    ? null
    : { code: row.unit_code, decimals: row.unit_decimals };
}

const ZERO = '0.0000';

// The sales of a period, a page of rows at a time (page) or every row (null, an export). Without
// withCost the cost columns are null; the service refuses a cost sort before it gets here.
export async function salesReport(
  tx: Transaction,
  filter: SalesReportFilter,
  options: { withCost: boolean; page: ReportPage | null },
): Promise<SalesReport> {
  const tenantId = getTenantId();
  const grouping = SALES_GROUPINGS[filter.groupBy];
  const sort = sortColumn(filter.sort, SALES_SORT_COLUMNS);
  const where: SQL[] = [];
  if (filter.branchId !== undefined) where.push(sql`l.branch_id = ${filter.branchId}::uuid`);
  // A walk-in has no group, so the group filter leaves the walk-ins out
  if (filter.customerGroupId !== undefined) {
    where.push(sql`c.customer_group_id = ${filter.customerGroupId}::uuid`);
  }
  if (filter.categoryId !== undefined) {
    where.push(inCategory(sql`p.category_id`, tenantId, filter.categoryId));
  }
  const found = await select(
    tx,
    sql`WITH lines AS (${salesLines(tenantId, filter.from, filter.to)}),
        grouped AS (
          SELECT ${grouping.select}, ${quantityColumns(filter.groupBy === 'product')},
                 sum(l.gross) AS gross, sum(l.returns) AS returns,
                 sum(l.gross) - sum(l.returns) AS net, sum(l.cost) AS cost
            FROM lines l
            JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
            LEFT JOIN parties c ON c.tenant_id = l.tenant_id AND c.id = l.customer_id
            ${grouping.joins}
           ${where.length === 0 ? sql`` : sql`WHERE ${sql.join(where, sql` AND `)}`}
           GROUP BY ${grouping.groupBy}
        )
        SELECT g.key, g.kind, g.id, g.code, g.name, g.month,
               round(g.quantity, 4)::text AS quantity, g.unit_code, g.unit_decimals,
               round(g.gross, 4)::text AS gross, round(g.returns, 4)::text AS returns,
               round(g.net, 4)::text AS net, round(g.cost, 4)::text AS cost,
               round(coalesce(sum(g.gross) OVER (), 0), 4)::text AS total_gross,
               round(coalesce(sum(g.returns) OVER (), 0), 4)::text AS total_returns,
               round(coalesce(sum(g.net) OVER (), 0), 4)::text AS total_net,
               round(coalesce(sum(g.cost) OVER (), 0), 4)::text AS total_cost
          FROM grouped g
         ORDER BY ${orderBy(sort, filter.sort === 'name' || filter.sort === '-name')}
         ${pageClause(options.page)}`,
    salesRowSchema,
  );
  const first = found[0];
  const page = pageRows(found, options.page);
  return {
    items: page.items.map((row) => ({
      key: row.key,
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      month: row.month,
      quantity: row.quantity,
      baseUnit: unitOf(row),
      gross: row.gross,
      returns: row.returns,
      net: row.net,
      ...costColumns(row.net, options.withCost ? row.cost : null),
    })),
    nextCursor: page.nextCursor,
    // No row = nothing sold: zeros, not an error
    totals: {
      gross: first?.total_gross ?? ZERO,
      returns: first?.total_returns ?? ZERO,
      net: first?.total_net ?? ZERO,
      ...costColumns(
        first?.total_net ?? ZERO,
        options.withCost ? (first?.total_cost ?? ZERO) : null,
      ),
    },
    withCost: options.withCost,
    // The books' lines carry a branch but no customer group and no category (decision 19)
    books:
      filter.customerGroupId === undefined && filter.categoryId === undefined
        ? await booksSales(tx, filter.from, filter.to, filter.branchId ?? null)
        : null,
  };
}

// The books' sales of the period, as the dashboard counts them (step 21a): credit − debit of the
// 'sales' account and of the Sales returns account, by account_day_totals, without the closing
// entries (a year-end close debits Sales with the whole year)
async function booksSales(
  tx: Transaction,
  from: string,
  to: string,
  branchId: string | null,
): Promise<string> {
  const books = await loadBooks(tx);
  if (books.salesAccountIds.length === 0) return ZERO;
  const [row] = await select(
    tx,
    sql`SELECT round(coalesce(sum(t.credit - t.debit), 0), 4)::text AS sales
          FROM account_day_totals t
         WHERE t.tenant_id = ${getTenantId()}::uuid
           AND t.account_id IN (${sql.join(
             books.salesAccountIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
           AND NOT t.closing
           AND t.day BETWEEN ${from}::date AND ${to}::date
           ${branchId === null ? sql`` : sql`AND t.branch_id = ${branchId}::uuid`}`,
    z.object({ sales: z.string() }),
  );
  return row?.sales ?? ZERO;
}

// ---------------------------------------------------------------------------------------------
// Purchases

// Every billed and debited line of the period (decision 4), net of discounts and before VAT:
// - a bill line: a product line (account_id NULL) or an account line (a service, with its expense
//   account);
// - a bill expense: an account and an amount, no product;
// - a debit note line, on the debit note's day and in its branch: an account line when the bill
//   line it debits is one. Only a line for goods that went back (a return line) takes the quantity
//   off. A debit note without a bill has only return lines: goods.
// - a debit note expense, with the bill expense's account.
function purchaseLines(tenantId: string, from: string, to: string): SQL {
  return sql`
    SELECT l.tenant_id, b.date AS day, b.supplier_id, b.branch_id, l.variant_id, l.account_id,
           l.net AS gross, 0::numeric AS returns,
           CASE WHEN l.account_id IS NULL THEN l.base_quantity ELSE 0 END AS quantity
      FROM bill_lines l
      JOIN bills b ON b.tenant_id = l.tenant_id AND b.id = l.bill_id
     WHERE l.tenant_id = ${tenantId}::uuid AND b.status = 'posted'
       AND b.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT e.tenant_id, b.date, b.supplier_id, b.branch_id, NULL::uuid, e.account_id,
           e.net, 0, 0
      FROM bill_expenses e
      JOIN bills b ON b.tenant_id = e.tenant_id AND b.id = e.bill_id
     WHERE e.tenant_id = ${tenantId}::uuid AND b.status = 'posted'
       AND b.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT l.tenant_id, d.date, d.supplier_id, d.branch_id, l.variant_id, bl.account_id,
           0, l.net,
           CASE WHEN l.return_line_id IS NULL OR bl.account_id IS NOT NULL THEN 0
                ELSE -l.base_quantity END
      FROM debit_note_lines l
      JOIN debit_notes d ON d.tenant_id = l.tenant_id AND d.id = l.debit_note_id
      LEFT JOIN bill_lines bl ON bl.tenant_id = l.tenant_id AND bl.id = l.bill_line_id
     WHERE l.tenant_id = ${tenantId}::uuid AND d.status = 'posted'
       AND d.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT e.tenant_id, d.date, d.supplier_id, d.branch_id, NULL::uuid, be.account_id,
           0, e.net, 0
      FROM debit_note_expenses e
      JOIN debit_notes d ON d.tenant_id = e.tenant_id AND d.id = e.debit_note_id
      JOIN bill_expenses be ON be.tenant_id = e.tenant_id AND be.id = e.bill_expense_id
     WHERE e.tenant_id = ${tenantId}::uuid AND d.status = 'posted'
       AND d.date BETWEEN ${from}::date AND ${to}::date`;
}

// The product (p) is joined for product lines only (account_id IS NULL): an account line's product
// is a service, which belongs in the "Expenses" row (decision 11), and an expense has none
const PURCHASE_GROUPINGS = {
  supplier: {
    select: sql`s.id::text AS key, 'item' AS kind, s.id::text AS id, s.code, s.name,
                NULL::text AS month`,
    joins: sql``,
    groupBy: sql`s.id`,
  },
  product: {
    select: sql`coalesce(p.id::text, 'expenses') AS key,
                CASE WHEN p.id IS NULL THEN 'expenses' ELSE 'item' END AS kind,
                p.id::text AS id, p.code, p.name, NULL::text AS month`,
    joins: sql``,
    groupBy: sql`p.id, u.id`,
  },
  account: {
    select: sql`coalesce(a.id::text, 'products') AS key,
                CASE WHEN a.id IS NULL THEN 'products' ELSE 'item' END AS kind,
                a.id::text AS id, a.code, a.name, NULL::text AS month`,
    joins: sql`LEFT JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id`,
    groupBy: sql`a.id`,
  },
  month: SALES_GROUPINGS.month,
} satisfies Record<PurchaseReportGroup, Grouping>;

const PURCHASE_SORT_COLUMNS = {
  name: SORT_NAME,
  // The "Expenses" row shows no quantity (its sum of zeros is not one): none, so last either way
  quantity: sql`CASE WHEN g.kind = 'item' THEN g.quantity END`,
  gross: sql`g.gross`,
  returns: sql`g.returns`,
  net: sql`g.net`,
} satisfies Record<SortColumn<PurchaseReportSort>, SQL>;

const purchaseRowSchema = z.object(tradeRowColumns);

export async function purchaseReport(
  tx: Transaction,
  filter: PurchaseReportFilter,
  options: { page: ReportPage | null },
): Promise<PurchaseReport> {
  const tenantId = getTenantId();
  const grouping = PURCHASE_GROUPINGS[filter.groupBy];
  const sort = sortColumn(filter.sort, PURCHASE_SORT_COLUMNS);
  const where: SQL[] = [];
  if (filter.branchId !== undefined) where.push(sql`l.branch_id = ${filter.branchId}::uuid`);
  if (filter.supplierGroupId !== undefined) {
    where.push(sql`s.supplier_group_id = ${filter.supplierGroupId}::uuid`);
  }
  // p is NULL on an account line or an expense, so they drop out: they have no category
  if (filter.categoryId !== undefined) {
    where.push(inCategory(sql`p.category_id`, tenantId, filter.categoryId));
  }
  const found = await select(
    tx,
    sql`WITH lines AS (${purchaseLines(tenantId, filter.from, filter.to)}),
        grouped AS (
          SELECT ${grouping.select}, ${quantityColumns(filter.groupBy === 'product')},
                 sum(l.gross) AS gross, sum(l.returns) AS returns,
                 sum(l.gross) - sum(l.returns) AS net
            FROM lines l
            JOIN parties s ON s.tenant_id = l.tenant_id AND s.id = l.supplier_id
            LEFT JOIN product_variants v
              ON l.account_id IS NULL AND v.tenant_id = l.tenant_id AND v.id = l.variant_id
            LEFT JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            LEFT JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
            ${grouping.joins}
           ${where.length === 0 ? sql`` : sql`WHERE ${sql.join(where, sql` AND `)}`}
           GROUP BY ${grouping.groupBy}
        )
        SELECT g.key, g.kind, g.id, g.code, g.name, g.month,
               -- The "Expenses" row adds no quantity: it has no product
               CASE WHEN g.kind = 'item' THEN round(g.quantity, 4)::text END AS quantity,
               g.unit_code, g.unit_decimals,
               round(g.gross, 4)::text AS gross, round(g.returns, 4)::text AS returns,
               round(g.net, 4)::text AS net,
               round(coalesce(sum(g.gross) OVER (), 0), 4)::text AS total_gross,
               round(coalesce(sum(g.returns) OVER (), 0), 4)::text AS total_returns,
               round(coalesce(sum(g.net) OVER (), 0), 4)::text AS total_net
          FROM grouped g
         ORDER BY ${orderBy(sort, filter.sort === 'name' || filter.sort === '-name')}
         ${pageClause(options.page)}`,
    purchaseRowSchema,
  );
  const first = found[0];
  const page = pageRows(found, options.page);
  return {
    items: page.items.map((row) => ({
      key: row.key,
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      month: row.month,
      quantity: row.quantity,
      baseUnit: unitOf(row),
      gross: row.gross,
      returns: row.returns,
      net: row.net,
    })),
    nextCursor: page.nextCursor,
    totals: {
      gross: first?.total_gross ?? ZERO,
      returns: first?.total_returns ?? ZERO,
      net: first?.total_net ?? ZERO,
    },
  };
}
