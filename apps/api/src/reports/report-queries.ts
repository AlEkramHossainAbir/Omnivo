import {
  ACCOUNT_TYPES,
  type AccountType,
  type BalanceSheet,
  type BalanceSheetQuery,
  compareCodes,
  isNegativeMoney,
  isZeroMoney,
  naturalAmount,
  type ProfitAndLoss,
  type ProfitAndLossQuery,
  type ReportAccount,
  reportSection,
  subtractMoney,
  sumMoney,
  type TrialBalance,
  type TrialBalanceQuery,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// The three reports, in plain SQL (build plan, step 11): a report is one GROUP BY over the posted
// lines, and SQL says that more clearly than a query builder. Each function takes the caller's
// transaction, so the API (a request) and the worker (an export job) run exactly the same queries.
//
// Two rules hold for every query here:
// - Only posted entries. A draft is not in the books.
// - Amounts come back as text, rounded to 4 places (NUMERIC(19,4)), never as a JavaScript number.
//   Dates come back as text too: the driver would turn a `date` into a Date at midnight UTC.

// Raw rows are data from outside TypeScript's view: checked with a schema, never cast
async function select<S extends z.ZodType>(
  tx: Transaction,
  query: SQL,
  row: S,
): Promise<z.output<S>[]> {
  return z.array(row).parse(await tx.execute(query));
}

// The join every report starts from: posted lines of this tenant with their entry and account.
// The tenant is named in the query even though RLS also filters by it, like every other query in
// the API: two locks on one door.
function postedLines(tenantId: string): SQL {
  return sql`
    FROM journal_lines l
    JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
    JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
    WHERE l.tenant_id = ${tenantId}::uuid AND e.status = 'posted'`;
}

// A closing entry (and the reversal that reopened its year) is not income or expense of the year:
// it only moves the year's profit into retained earnings. The profit and loss leaves both out —
// with them, every closed year would show a profit of zero.
function withoutClosingEntries(): SQL {
  return sql`
    AND e.source <> 'year_close'
    AND NOT EXISTS (
      SELECT 1 FROM journal_entries o
       WHERE o.tenant_id = e.tenant_id AND o.id = e.reversal_of_id AND o.source = 'year_close'
    )`;
}

// debit − credit of the lines that match `filter`, rounded like the column: "0.0000" when none do
function signedSum(filter: SQL): SQL {
  return sql`round(coalesce(sum(l.debit - l.credit) FILTER (WHERE ${filter}), 0), 4)::text`;
}

// Every account of the chart, groups included: the sections need the tree to sum the groups
async function loadAccounts(tx: Transaction): Promise<ReportAccount[]> {
  const rows = await select(
    tx,
    sql`SELECT id::text, parent_id::text, code, name, type, is_group
          FROM ledger_accounts WHERE tenant_id = ${getTenantId()}::uuid`,
    z.object({
      id: z.uuid(),
      parent_id: z.uuid().nullable(),
      code: z.string(),
      name: z.string(),
      type: z.enum(ACCOUNT_TYPES),
      is_group: z.boolean(),
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    code: row.code,
    name: row.name,
    type: row.type,
    isGroup: row.is_group,
  }));
}

// A signed balance split into the debit and credit columns of a totals row
function sides(values: readonly string[]): { debit: string; credit: string } {
  return {
    debit: sumMoney(values.filter((value) => !isNegativeMoney(value))),
    credit: sumMoney(values.filter(isNegativeMoney).map((value) => subtractMoney('0', value))),
  };
}

export async function trialBalance(
  tx: Transaction,
  query: TrialBalanceQuery,
): Promise<TrialBalance> {
  const rows = await select(
    tx,
    sql`SELECT a.id::text AS account_id, a.code, a.name, a.type,
               ${signedSum(sql`e.date < ${query.from}::date`)} AS opening,
               round(coalesce(sum(l.debit) FILTER (WHERE e.date >= ${query.from}::date), 0), 4)::text AS debit,
               round(coalesce(sum(l.credit) FILTER (WHERE e.date >= ${query.from}::date), 0), 4)::text AS credit,
               ${signedSum(sql`true`)} AS closing
        ${postedLines(getTenantId())}
          AND e.date <= ${query.to}::date
        GROUP BY a.id, a.code, a.name, a.type`,
    z.object({
      account_id: z.uuid(),
      code: z.string(),
      name: z.string(),
      type: z.enum(ACCOUNT_TYPES),
      opening: z.string(),
      debit: z.string(),
      credit: z.string(),
      closing: z.string(),
    }),
  );
  // An account whose lines cancel out before the range and that did not move inside it has
  // nothing to say: zero in all four columns
  const items = rows
    .filter((row) => [row.opening, row.debit, row.credit, row.closing].some((v) => !isZeroMoney(v)))
    .map((row) => ({
      accountId: row.account_id,
      code: row.code,
      name: row.name,
      type: row.type,
      opening: row.opening,
      debit: row.debit,
      credit: row.credit,
      closing: row.closing,
    }))
    .sort((a, b) => compareCodes(a.code, b.code));
  const opening = sides(items.map((row) => row.opening));
  const closing = sides(items.map((row) => row.closing));
  return {
    rows: items,
    totals: {
      openingDebit: opening.debit,
      openingCredit: opening.credit,
      debit: sumMoney(items.map((row) => row.debit)),
      credit: sumMoney(items.map((row) => row.credit)),
      closingDebit: closing.debit,
      closingCredit: closing.credit,
    },
  };
}

// account id → amount in the type's natural sign, for one column
type Amounts = Map<string, string>;

const balanceRowSchema = z.object({
  account_id: z.uuid(),
  type: z.enum(ACCOUNT_TYPES),
  current: z.string(),
  compare: z.string(),
});

function columns(
  rows: readonly z.output<typeof balanceRowSchema>[],
  withCompare: boolean,
): { current: Amounts; compare: Amounts | null } {
  const current: Amounts = new Map();
  const compare: Amounts = new Map();
  for (const row of rows) {
    current.set(row.account_id, naturalAmount(row.type, row.current));
    compare.set(row.account_id, naturalAmount(row.type, row.compare));
  }
  return { current, compare: withCompare ? compare : null };
}

export async function profitAndLoss(
  tx: Transaction,
  query: ProfitAndLossQuery,
): Promise<ProfitAndLoss> {
  const inRange = sql`e.date BETWEEN ${query.from}::date AND ${query.to}::date`;
  const inCompare =
    query.compareFrom !== undefined && query.compareTo !== undefined
      ? sql`e.date BETWEEN ${query.compareFrom}::date AND ${query.compareTo}::date`
      : sql`false`;
  const rows = await select(
    tx,
    sql`SELECT l.account_id::text AS account_id, a.type,
               ${signedSum(inRange)} AS current, ${signedSum(inCompare)} AS compare
        ${postedLines(getTenantId())}
          AND a.type IN ('income', 'expense')
          AND (${inRange} OR ${inCompare})
          ${withoutClosingEntries()}
          ${query.branchId === undefined ? sql`` : sql`AND l.branch_id = ${query.branchId}::uuid`}
        GROUP BY l.account_id, a.type`,
    balanceRowSchema,
  );
  const accounts = await loadAccounts(tx);
  const { current, compare } = columns(rows, query.compareFrom !== undefined);
  const income = reportSection('income', accounts, current, compare);
  const expense = reportSection('expense', accounts, current, compare);
  return {
    income,
    expense,
    netProfit: subtractMoney(income.total, expense.total),
    compareNetProfit:
      income.compareTotal === null || expense.compareTotal === null
        ? null
        : subtractMoney(income.compareTotal, expense.compareTotal),
  };
}

// Income and expenses that no closing entry has emptied yet, up to a day: the profit not closed
// into retained earnings. Read in the natural sign of income (a profit is positive).
function profitOf(
  rows: readonly z.output<typeof balanceRowSchema>[],
  column: 'current' | 'compare',
) {
  return naturalAmount(
    'income',
    sumMoney(
      rows
        .filter((row) => row.type === 'income' || row.type === 'expense')
        .map((row) => row[column]),
    ),
  );
}

export async function balanceSheet(
  tx: Transaction,
  query: BalanceSheetQuery,
): Promise<BalanceSheet> {
  const compareAsOf = query.compareAsOf ?? null;
  const rows = await select(
    tx,
    sql`SELECT l.account_id::text AS account_id, a.type,
               ${signedSum(sql`e.date <= ${query.asOf}::date`)} AS current,
               ${signedSum(compareAsOf === null ? sql`false` : sql`e.date <= ${compareAsOf}::date`)} AS compare
        ${postedLines(getTenantId())}
          AND e.date <= greatest(${query.asOf}::date, ${compareAsOf}::date)
        GROUP BY l.account_id, a.type`,
    balanceRowSchema,
  );
  const accounts = await loadAccounts(tx);
  const sheetRows = rows.filter((row) => !['income', 'expense'].includes(row.type));
  const { current, compare } = columns(sheetRows, compareAsOf !== null);
  const asset = reportSection('asset', accounts, current, compare);
  const liability = reportSection('liability', accounts, current, compare);
  const equity = reportSection('equity', accounts, current, compare);
  const profitNotClosed = profitOf(rows, 'current');
  const compareProfit = compareAsOf === null ? null : profitOf(rows, 'compare');
  return {
    asset,
    liability,
    equity,
    profitNotClosed,
    compareProfitNotClosed: compareProfit,
    liabilitiesAndEquity: sumMoney([liability.total, equity.total, profitNotClosed]),
    compareLiabilitiesAndEquity:
      compareProfit === null || liability.compareTotal === null || equity.compareTotal === null
        ? null
        : sumMoney([liability.compareTotal, equity.compareTotal, compareProfit]),
  };
}

// The signed balance (debit − credit) of every income and expense account up to and including a
// day, closing entries included: what a closing entry dated that day has to empty
export async function profitAndLossBalances(
  tx: Transaction,
  upTo: string,
): Promise<{ accountId: string; type: AccountType; balance: string }[]> {
  const rows = await select(
    tx,
    sql`SELECT l.account_id::text AS account_id, a.type, ${signedSum(sql`true`)} AS balance
        ${postedLines(getTenantId())}
          AND a.type IN ('income', 'expense')
          AND e.date <= ${upTo}::date
        GROUP BY l.account_id, a.type, a.code
        ORDER BY a.code`,
    z.object({ account_id: z.uuid(), type: z.enum(ACCOUNT_TYPES), balance: z.string() }),
  );
  return rows
    .filter((row) => !isZeroMoney(row.balance))
    .map((row) => ({ accountId: row.account_id, type: row.type, balance: row.balance }));
}

// Income − expenses of each day, without closing entries: the fiscal year list sums its days
export async function dailyProfit(tx: Transaction): Promise<Map<string, string>> {
  const rows = await select(
    tx,
    sql`SELECT e.date::text AS date, ${signedSum(sql`true`)} AS net
        ${postedLines(getTenantId())}
          AND a.type IN ('income', 'expense')
          ${withoutClosingEntries()}
        GROUP BY e.date`,
    z.object({ date: z.iso.date(), net: z.string() }),
  );
  return new Map(rows.map((row) => [row.date, naturalAmount('income', row.net)]));
}
