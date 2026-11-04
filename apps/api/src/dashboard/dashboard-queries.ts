import {
  type AccountPurpose,
  compareCodes,
  compareMoney,
  DASHBOARD_LOW_STOCK_ITEMS,
  DASHBOARD_TOP_PRODUCTS,
  DASHBOARD_TREND_DAYS,
  type DashboardCash,
  type DashboardDues,
  type DashboardLowStock,
  type DashboardMargin,
  type DashboardPeriods,
  type DashboardSales,
  type DashboardTopProduct,
  everyDay,
  moneyAccountIds,
  sumMoney,
  todayIn,
} from '@omnivo/contracts';
import { ledgerAccounts, tenantSettings } from '@omnivo/db';
import { eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { incomingTo, quantityText } from '../inventory/stock.service.js';

// The dashboard's questions (step 21a), in plain SQL like the reports (report-queries.ts). Each
// takes the caller's transaction. The money comes from account_day_totals (21a.2), one row per
// day, account and branch, never from the journal's lines: that is what keeps the page fast on a
// workspace with years of entries. Amounts and dates come back as text, 4 decimals, like every
// report: the driver would turn a NUMERIC into a float and a `date` into a Date at midnight UTC.

// Raw rows are data from outside TypeScript's view: checked with a schema, never cast
async function rows<S extends z.ZodType>(
  tx: Transaction,
  query: SQL,
  row: S,
): Promise<z.output<S>[]> {
  return z.array(row).parse(await tx.execute(query));
}

// `column IN (…)`. An empty list matches nothing: SQL has no empty IN list, and a workspace whose
// chart the setup job has not made yet has no sales account. Its dashboard is zeros, not an error.
function inIds(column: SQL, ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`false`;
  return sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

// No branch = the whole workspace (decision 11)
function inBranch(column: SQL, branchId: string | null): SQL {
  return branchId === null ? sql`` : sql`AND ${column} = ${branchId}::uuid`;
}

// ---------------------------------------------------------------------------------------------
// The accounts

// What every card starts from, read once: the workspace's today and the accounts the cards add
// up. The whole chart is read, as assertMoneyAccount() does (step 15c): it is a few hundred rows at
// most, and moneyAccountIds() needs its tree.
export interface DashboardBooks {
  today: string;
  // The 'sales' purpose account, and the Sales returns account of Settings → Sales when one is
  // chosen (decision 10)
  salesAccountIds: string[];
  // The 'cost_of_goods_sold' purpose account: what the margin takes off the sales
  costAccountId: string | null;
  receivableAccountId: string | null;
  payableAccountId: string | null;
  // Every active account money is kept in, as the receipt form offers them
  moneyAccounts: { id: string; code: string; name: string }[];
}

export async function loadBooks(tx: Transaction): Promise<DashboardBooks> {
  const tenantId = getTenantId();
  const [chart, [settings]] = await Promise.all([
    tx
      .select({
        id: ledgerAccounts.id,
        parentId: ledgerAccounts.parentId,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        purpose: ledgerAccounts.purpose,
        isGroup: ledgerAccounts.isGroup,
        holdsMoney: ledgerAccounts.holdsMoney,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.tenantId, tenantId)),
    tx
      .select({
        timezone: tenantSettings.timezone,
        salesReturnsAccountId: tenantSettings.salesReturnsAccountId,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId)),
  ]);
  // Every chart has one account of each purpose (templates.spec.ts), or none before the setup job
  const idOf = (purpose: AccountPurpose): string | null =>
    chart.find((account) => account.purpose === purpose)?.id ?? null;
  const money = moneyAccountIds(
    chart.map((account) => ({
      ...account,
      archivedAt: account.archivedAt?.toISOString() ?? null,
    })),
  );
  const sales = [idOf('sales'), settings?.salesReturnsAccountId ?? null];
  return {
    today: todayIn(settings?.timezone ?? 'Asia/Dhaka'),
    salesAccountIds: [...new Set(sales.filter((id): id is string => id !== null))],
    costAccountId: idOf('cost_of_goods_sold'),
    receivableAccountId: idOf('accounts_receivable'),
    payableAccountId: idOf('accounts_payable'),
    moneyAccounts: chart
      .filter((account) => money.has(account.id))
      .map(({ id, code, name }) => ({ id, code, name })),
  };
}

// ---------------------------------------------------------------------------------------------
// Sales and margin

export interface DaySold {
  sales: string;
  cost: string;
}

// The first day the sales and the margin need: the 1st of last month or the chart's first day,
// whichever is earlier. Usually the 1st (1 October against 4 October on 2 November), but not
// always: on 1 March the chart starts on 31 January.
export function soldFrom(periods: DashboardPeriods): string {
  return periods.lastMonthStart < periods.trendStart ? periods.lastMonthStart : periods.trendStart;
}

// The sales (credit − debit of the sales accounts: a return is a debit) and the cost of goods sold
// (debit − credit) of each day from `from` to today, of one branch or of all. Closing entries are
// left out (decision 25): a year-end close debits Sales with the whole year's sales, and 30 June
// would show the year's sales below zero.
export async function soldByDay(
  tx: Transaction,
  books: DashboardBooks,
  from: string,
  branchId: string | null,
): Promise<Map<string, DaySold>> {
  const cost = books.costAccountId === null ? [] : [books.costAccountId];
  const found = await rows(
    tx,
    sql`SELECT t.day::text AS day,
               round(coalesce(sum(t.credit - t.debit)
                 FILTER (WHERE ${inIds(sql`t.account_id`, books.salesAccountIds)}), 0), 4)::text AS sales,
               round(coalesce(sum(t.debit - t.credit)
                 FILTER (WHERE ${inIds(sql`t.account_id`, cost)}), 0), 4)::text AS cost
          FROM account_day_totals t
         WHERE t.tenant_id = ${getTenantId()}::uuid
           AND ${inIds(sql`t.account_id`, [...books.salesAccountIds, ...cost])}
           AND NOT t.closing
           AND t.day BETWEEN ${from}::date AND ${books.today}::date
           ${inBranch(sql`t.branch_id`, branchId)}
         GROUP BY t.day`,
    z.object({ day: z.iso.date(), sales: z.string(), cost: z.string() }),
  );
  return new Map(found.map((row) => [row.day, { sales: row.sales, cost: row.cost }]));
}

// One column added up over the days from `from` to `to`, both included. ISO dates compare as
// strings. A day with no row adds nothing.
function sumDays(
  days: ReadonlyMap<string, DaySold>,
  from: string,
  to: string,
  column: keyof DaySold,
): string {
  const values: string[] = [];
  for (const [day, sold] of days) {
    if (day >= from && day <= to) values.push(sold[column]);
  }
  return sumMoney(values);
}

export function salesCard(
  days: ReadonlyMap<string, DaySold>,
  periods: DashboardPeriods,
): DashboardSales {
  return {
    today: sumDays(days, periods.today, periods.today, 'sales'),
    yesterday: sumDays(days, periods.yesterday, periods.yesterday, 'sales'),
    monthToDate: sumDays(days, periods.monthStart, periods.today, 'sales'),
    lastMonthToDate: sumDays(days, periods.lastMonthStart, periods.lastMonthEnd, 'sales'),
    days: everyDay(
      periods.trendStart,
      DASHBOARD_TREND_DAYS,
      new Map([...days].map(([day, sold]) => [day, sold.sales])),
    ),
  };
}

export function marginCard(
  days: ReadonlyMap<string, DaySold>,
  periods: DashboardPeriods,
): DashboardMargin {
  const period = (from: string, to: string) => ({
    sales: sumDays(days, from, to, 'sales'),
    cost: sumDays(days, from, to, 'cost'),
  });
  return {
    monthToDate: period(periods.monthStart, periods.today),
    lastMonthToDate: period(periods.lastMonthStart, periods.lastMonthEnd),
  };
}

// ---------------------------------------------------------------------------------------------
// Cash and dues: the whole workspace's, up to today

// Every money account's balance at the end of today and at the end of yesterday. Up to today
// only: an entry dated next week (a cheque written today for then) is not money in the bank yet.
// A closing entry never touches a money account, so `closing` is not filtered.
export async function cashCard(tx: Transaction, books: DashboardBooks): Promise<DashboardCash> {
  const found = await rows(
    tx,
    sql`SELECT t.account_id::text AS account_id,
               round(sum(t.debit - t.credit), 4)::text AS balance,
               round(coalesce(sum(t.debit - t.credit)
                 FILTER (WHERE t.day < ${books.today}::date), 0), 4)::text AS yesterday
          FROM account_day_totals t
         WHERE t.tenant_id = ${getTenantId()}::uuid
           AND ${inIds(
             sql`t.account_id`,
             books.moneyAccounts.map((account) => account.id),
           )}
           AND t.day <= ${books.today}::date
         GROUP BY t.account_id`,
    z.object({ account_id: z.uuid(), balance: z.string(), yesterday: z.string() }),
  );
  const balances = new Map(found.map((row) => [row.account_id, row.balance]));
  // An account with no entries yet is still shown, at zero: the owner sees every account they keep
  const accounts = books.moneyAccounts
    .map((account) => ({
      accountId: account.id,
      code: account.code,
      name: account.name,
      balance: balances.get(account.id) ?? '0.0000',
    }))
    .sort((a, b) => compareMoney(b.balance, a.balance) || compareCodes(a.code, b.code));
  return {
    accounts,
    total: sumMoney(accounts.map((account) => account.balance)),
    yesterday: sumMoney(found.map((row) => row.yesterday)),
  };
}

// A control account's balance up to today, in its natural sign: debit − credit for the
// receivable (what customers owe), credit − debit for the payable (what is owed to suppliers)
async function controlBalance(
  tx: Transaction,
  accountId: string | null,
  today: string,
  side: 'debit' | 'credit',
): Promise<string> {
  if (accountId === null) return '0.0000';
  const amount = side === 'debit' ? sql`t.debit - t.credit` : sql`t.credit - t.debit`;
  const [row] = await rows(
    tx,
    sql`SELECT round(coalesce(sum(${amount}), 0), 4)::text AS balance
          FROM account_day_totals t
         WHERE t.tenant_id = ${getTenantId()}::uuid AND t.account_id = ${accountId}::uuid
           AND t.day <= ${today}::date`,
    z.object({ balance: z.string() }),
  );
  return row?.balance ?? '0.0000';
}

const overdueSchema = z.object({ overdue: z.string(), count: z.number().int() });

// Posted, not settled in full, and due before today: isOverdue() in invoices.ts. The WHERE says
// "open" in the same words as invoices_open_due_idx, so Postgres reads that partial index.
export async function receivablesCard(
  tx: Transaction,
  books: DashboardBooks,
): Promise<DashboardDues> {
  const [total, [overdue]] = await Promise.all([
    controlBalance(tx, books.receivableAccountId, books.today, 'debit'),
    rows(
      tx,
      sql`SELECT round(coalesce(sum(total - amount_paid - amount_credited), 0), 4)::text AS overdue,
                 count(*)::int AS count
            FROM invoices
           WHERE tenant_id = ${getTenantId()}::uuid
             AND status = 'posted' AND amount_paid + amount_credited < total
             AND due_date < ${books.today}::date`,
      overdueSchema,
    ),
  ]);
  return { total, overdue: overdue?.overdue ?? '0.0000', overdueCount: overdue?.count ?? 0 };
}

// The same for the suppliers' bills: isBillOverdue() in bills.ts and bills_open_due_idx
export async function payablesCard(tx: Transaction, books: DashboardBooks): Promise<DashboardDues> {
  const [total, [overdue]] = await Promise.all([
    controlBalance(tx, books.payableAccountId, books.today, 'credit'),
    rows(
      tx,
      sql`SELECT round(coalesce(sum(total - amount_paid - amount_debited), 0), 4)::text AS overdue,
                 count(*)::int AS count
            FROM bills
           WHERE tenant_id = ${getTenantId()}::uuid
             AND status = 'posted' AND amount_paid + amount_debited < total
             AND due_date < ${books.today}::date`,
      overdueSchema,
    ),
  ]);
  return { total, overdue: overdue?.overdue ?? '0.0000', overdueCount: overdue?.count ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Products and stock

const variantColumns = {
  variant_id: z.uuid(),
  product_id: z.uuid(),
  product_code: z.string(),
  product_name: z.string(),
  option_values: z.array(z.string()),
  sku: z.string(),
  base_unit_id: z.uuid(),
  unit_code: z.string(),
  unit_decimals: z.number().int(),
};

function variantOf(row: z.output<z.ZodObject<typeof variantColumns>>) {
  return {
    variantId: row.variant_id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    optionValues: row.option_values,
    sku: row.sku,
    baseUnitId: row.base_unit_id,
    baseUnit: { code: row.unit_code, decimals: row.unit_decimals },
  };
}

// What sold most in the chart's days (decision 18): the lines of posted invoices and of POS sales,
// before their returns, the largest amount after discounts and before VAT first. A POS sale's
// branch is its warehouse's (it has no branch_id). The dates are the documents' own, like the
// books: an invoice dated 31 October counts on 31 October.
export async function topProducts(
  tx: Transaction,
  periods: DashboardPeriods,
  branchId: string | null,
): Promise<DashboardTopProduct[]> {
  const tenantId = getTenantId();
  const found = await rows(
    tx,
    sql`SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
               p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
               u.code AS unit_code, u.decimals AS unit_decimals,
               round(sum(sold.base_quantity), 4)::text AS quantity,
               round(sum(sold.net), 4)::text AS amount
          FROM (
            SELECT l.tenant_id, l.variant_id, l.base_quantity, l.net
              FROM invoice_lines l
              JOIN invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
             WHERE l.tenant_id = ${tenantId}::uuid AND i.status = 'posted'
               AND i.date BETWEEN ${periods.trendStart}::date AND ${periods.today}::date
               ${inBranch(sql`i.branch_id`, branchId)}
            UNION ALL
            SELECT l.tenant_id, l.variant_id, l.base_quantity, l.net
              FROM pos_sale_lines l
              JOIN pos_sales s ON s.tenant_id = l.tenant_id AND s.id = l.sale_id
              JOIN warehouses w ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
             WHERE l.tenant_id = ${tenantId}::uuid
               AND s.date BETWEEN ${periods.trendStart}::date AND ${periods.today}::date
               ${inBranch(sql`w.branch_id`, branchId)}
          ) sold
          JOIN product_variants v ON v.tenant_id = sold.tenant_id AND v.id = sold.variant_id
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
         GROUP BY v.id, p.id, u.id
         ORDER BY sum(sold.net) DESC, v.id
         LIMIT ${DASHBOARD_TOP_PRODUCTS}`,
    z.object({ ...variantColumns, quantity: z.string(), amount: z.string() }),
  );
  return found.map((row) => ({ ...variantOf(row), quantity: row.quantity, amount: row.amount }));
}

// The reorder report's rows (StockService.reorder, step 13): every variant and active warehouse at
// or below its level, with what is on its way there. Here the emptiest first (decision 19): the
// smallest share of the level on hand, below zero (sold short) before empty. A level of 0 has no
// share; sign() puts its row with the empty ones (0) or the ones below zero (-1). count(*) OVER ()
// is worked out before the LIMIT: how many there are in all, in the same query.
export async function lowStockCard(tx: Transaction): Promise<DashboardLowStock> {
  const found = await rows(
    tx,
    sql`SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
               p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
               u.code AS unit_code, u.decimals AS unit_decimals,
               r.warehouse_id::text AS warehouse_id, w.name AS warehouse_name,
               ${quantityText(sql`s.on_hand`)} AS on_hand,
               ${quantityText(sql`(SELECT sum(l.base_quantity) FROM stock_transfer_lines l
                  JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
                 WHERE l.tenant_id = r.tenant_id AND l.variant_id = r.variant_id
                   AND t.status = 'in_transit' AND t.to_warehouse_id = r.warehouse_id)`)} AS in_transit,
               ${incomingTo(sql`r.warehouse_id`)} AS incoming,
               round(r.min_quantity, 4)::text AS min_quantity,
               round(r.reorder_quantity, 4)::text AS reorder_quantity,
               count(*) OVER ()::int AS count
          FROM reorder_levels r
          JOIN warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id AND w.archived_at IS NULL
          JOIN product_variants v ON v.tenant_id = r.tenant_id AND v.id = r.variant_id
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
          LEFT JOIN LATERAL (
            SELECT sum(sb.quantity) AS on_hand FROM stock_balances sb
             WHERE sb.tenant_id = r.tenant_id AND sb.warehouse_id = r.warehouse_id
               AND sb.variant_id = r.variant_id
          ) s ON true
         WHERE r.tenant_id = ${getTenantId()}::uuid
           AND coalesce(s.on_hand, 0) <= r.min_quantity
           AND p.archived_at IS NULL AND v.archived_at IS NULL
         ORDER BY CASE WHEN r.min_quantity > 0 THEN coalesce(s.on_hand, 0) / r.min_quantity
                       ELSE sign(coalesce(s.on_hand, 0)) END,
                  lower(p.name), v.id, r.warehouse_id
         LIMIT ${DASHBOARD_LOW_STOCK_ITEMS}`,
    z.object({
      ...variantColumns,
      warehouse_id: z.uuid(),
      warehouse_name: z.string(),
      on_hand: z.string(),
      in_transit: z.string(),
      incoming: z.string(),
      min_quantity: z.string(),
      reorder_quantity: z.string().nullable(),
      count: z.number().int(),
    }),
  );
  return {
    count: found[0]?.count ?? 0,
    items: found.map((row) => ({
      ...variantOf(row),
      warehouseId: row.warehouse_id,
      warehouseName: row.warehouse_name,
      onHand: row.on_hand,
      inTransit: row.in_transit,
      incoming: row.incoming,
      minQuantity: row.min_quantity,
      reorderQuantity: row.reorder_quantity,
    })),
  };
}
