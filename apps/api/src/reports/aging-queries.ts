import {
  agingAmountsOf,
  agingBucketOf,
  type AgingReport,
  type AgingSort,
  type ApAgingFilter,
  type ApAgingParty,
  AP_ADVANCE_KINDS,
  type ArAgingFilter,
  type ArAgingParty,
  AR_ADVANCE_KINDS,
  daysOverdue,
  type PartyRef,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { notFound } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { loadBooks } from '../dashboard/dashboard-queries.js';
import {
  pageClause,
  pageRows,
  type ReportPage,
  select,
  sortColumn,
  type SortColumn,
} from './report-paging.js';

// The receivables and payables aging (step 21b), in plain SQL. As of a day D (decision 5):
// - A document's open amount on D is what is open now plus what was applied to it after D. The
//   invoice (or bill) keeps what is applied to it now (amount_paid, amount_credited, kept by the
//   allocations' triggers), and the allocations with applied_on after D are the ones that were not
//   there yet. So only the invoices open now and the ones paid after D are read: the open
//   invoices' partial index and the allocations' applied_on index (21b.2, decision 28), never every
//   invoice the workspace ever had.
// - An advance on D is the money of a receipt (or credit note, payment, debit note) dated D or
//   before, less what of it was applied by D, less what refunds of D or before paid back. A receipt
//   voided after D still counts on D: the books took it back only on the void day. Its allocations
//   were deleted with the void, so on those days its invoices show open and the receipt as an
//   advance; the balance is still the books' (the known gap of decision 5).
// - No branch (decision 6). A party with nothing open and no advance has no row.

// One kind of aging: the receivables (customers, invoices, receipts and credit notes) or the
// payables (suppliers, bills, payments and debit notes)
interface AgingSide {
  // id, party_id, number, date, due_date, total, open, and supplier_bill_number (NULL for an invoice)
  documents: (tenantId: string, asOf: string) => SQL;
  // id, kind, party_id, number, date, amount
  advances: (tenantId: string, asOf: string) => SQL;
  // The group filter's column, and who counts as a party of this aging
  groupColumn: SQL;
  isParty: SQL;
  // The account's balance in the report's sense: what customers owe is a debit balance, what is
  // owed to suppliers a credit one
  account: 'receivable' | 'payable';
}

// What was applied after D, by document, and what refunds after D gave back: in the "candidates"
// of the advances below. Every EXISTS reads an index that starts with the tenant and the document.
const RECEIVABLES: AgingSide = {
  documents: (tenantId, asOf) => sql`
    WITH later AS (
      SELECT a.invoice_id, sum(a.amount) AS amount
        FROM (
          SELECT invoice_id, amount FROM receipt_allocations
           WHERE tenant_id = ${tenantId}::uuid AND applied_on > ${asOf}::date
          UNION ALL
          SELECT invoice_id, amount FROM credit_note_allocations
           WHERE tenant_id = ${tenantId}::uuid AND applied_on > ${asOf}::date
        ) a
       GROUP BY a.invoice_id
    )
    SELECT i.id, i.customer_id AS party_id, i.number, i.date, i.due_date, i.total,
           i.total - i.amount_paid - i.amount_credited + coalesce(l.amount, 0) AS open,
           NULL::text AS supplier_bill_number
      FROM invoices i
      LEFT JOIN later l ON l.invoice_id = i.id
     WHERE i.tenant_id = ${tenantId}::uuid AND i.status = 'posted' AND i.date <= ${asOf}::date
       AND (i.amount_paid + i.amount_credited < i.total OR l.invoice_id IS NOT NULL)`,
  advances: (tenantId, asOf) => sql`
    SELECT r.id, 'receipt' AS kind, r.customer_id AS party_id, r.number, r.date,
           r.amount
             - coalesce((SELECT sum(a.amount) FROM receipt_allocations a
                          WHERE a.tenant_id = r.tenant_id AND a.receipt_id = r.id
                            AND a.applied_on <= ${asOf}::date), 0)
             - coalesce((SELECT sum(f.amount) FROM refunds f
                          WHERE f.tenant_id = r.tenant_id AND f.receipt_id = r.id
                            AND f.date <= ${asOf}::date
                            AND (f.status = 'posted' OR f.void_date > ${asOf}::date)), 0) AS amount
      FROM receipts r
     WHERE r.tenant_id = ${tenantId}::uuid AND r.date <= ${asOf}::date
       AND (r.status = 'posted' OR r.void_date > ${asOf}::date)
       AND (r.status = 'voided' OR r.applied + r.refunded < r.amount
            OR EXISTS (SELECT 1 FROM receipt_allocations a
                        WHERE a.tenant_id = r.tenant_id AND a.receipt_id = r.id
                          AND a.applied_on > ${asOf}::date)
            OR EXISTS (SELECT 1 FROM refunds f
                        WHERE f.tenant_id = r.tenant_id AND f.receipt_id = r.id
                          AND f.date > ${asOf}::date))
    UNION ALL
    SELECT c.id, 'credit_note', c.customer_id, c.number, c.date,
           c.total
             - coalesce((SELECT sum(a.amount) FROM credit_note_allocations a
                          WHERE a.tenant_id = c.tenant_id AND a.credit_note_id = c.id
                            AND a.applied_on <= ${asOf}::date), 0)
             - coalesce((SELECT sum(f.amount) FROM refunds f
                          WHERE f.tenant_id = c.tenant_id AND f.credit_note_id = c.id
                            AND f.date <= ${asOf}::date
                            AND (f.status = 'posted' OR f.void_date > ${asOf}::date)), 0)
      FROM credit_notes c
     WHERE c.tenant_id = ${tenantId}::uuid AND c.status = 'posted' AND c.date <= ${asOf}::date
       AND (c.applied + c.refunded < c.total
            OR EXISTS (SELECT 1 FROM credit_note_allocations a
                        WHERE a.tenant_id = c.tenant_id AND a.credit_note_id = c.id
                          AND a.applied_on > ${asOf}::date)
            OR EXISTS (SELECT 1 FROM refunds f
                        WHERE f.tenant_id = c.tenant_id AND f.credit_note_id = c.id
                          AND f.date > ${asOf}::date))`,
  groupColumn: sql`p.customer_group_id`,
  isParty: sql`p.is_customer`,
  account: 'receivable',
};

// The same for suppliers. Only a posted payment pays a bill: a draft's or a pending payment's
// allocations are its plan (step 17c), and the bill's amount_paid leaves them out too. A payment
// waiting for approval is not in the books yet, so it is no advance either.
const PAYABLES: AgingSide = {
  documents: (tenantId, asOf) => sql`
    WITH later AS (
      SELECT a.bill_id, sum(a.amount) AS amount
        FROM (
          SELECT a.bill_id, a.amount FROM supplier_payment_allocations a
            JOIN supplier_payments sp ON sp.tenant_id = a.tenant_id AND sp.id = a.payment_id
           WHERE a.tenant_id = ${tenantId}::uuid AND a.applied_on > ${asOf}::date
             AND sp.status = 'posted'
          UNION ALL
          SELECT bill_id, amount FROM debit_note_allocations
           WHERE tenant_id = ${tenantId}::uuid AND applied_on > ${asOf}::date
        ) a
       GROUP BY a.bill_id
    )
    SELECT b.id, b.supplier_id AS party_id, b.number, b.date, b.due_date, b.total,
           b.total - b.amount_paid - b.amount_debited + coalesce(l.amount, 0) AS open,
           b.supplier_bill_number
      FROM bills b
      LEFT JOIN later l ON l.bill_id = b.id
     WHERE b.tenant_id = ${tenantId}::uuid AND b.status = 'posted' AND b.date <= ${asOf}::date
       AND (b.amount_paid + b.amount_debited < b.total OR l.bill_id IS NOT NULL)`,
  advances: (tenantId, asOf) => sql`
    SELECT sp.id, 'payment' AS kind, sp.supplier_id AS party_id, sp.number, sp.date,
           sp.amount
             - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a
                          WHERE a.tenant_id = sp.tenant_id AND a.payment_id = sp.id
                            AND a.applied_on <= ${asOf}::date), 0)
             - coalesce((SELECT sum(f.amount) FROM supplier_refunds f
                          WHERE f.tenant_id = sp.tenant_id AND f.payment_id = sp.id
                            AND f.date <= ${asOf}::date
                            AND (f.status = 'posted' OR f.void_date > ${asOf}::date)), 0) AS amount
      FROM supplier_payments sp
     WHERE sp.tenant_id = ${tenantId}::uuid AND sp.date <= ${asOf}::date
       AND (sp.status = 'posted' OR (sp.status = 'voided' AND sp.void_date > ${asOf}::date))
       AND (sp.status = 'voided' OR sp.applied + sp.refunded < sp.amount
            OR EXISTS (SELECT 1 FROM supplier_payment_allocations a
                        WHERE a.tenant_id = sp.tenant_id AND a.payment_id = sp.id
                          AND a.applied_on > ${asOf}::date)
            OR EXISTS (SELECT 1 FROM supplier_refunds f
                        WHERE f.tenant_id = sp.tenant_id AND f.payment_id = sp.id
                          AND f.date > ${asOf}::date))
    UNION ALL
    SELECT d.id, 'debit_note', d.supplier_id, d.number, d.date,
           d.total
             - coalesce((SELECT sum(a.amount) FROM debit_note_allocations a
                          WHERE a.tenant_id = d.tenant_id AND a.debit_note_id = d.id
                            AND a.applied_on <= ${asOf}::date), 0)
             - coalesce((SELECT sum(f.amount) FROM supplier_refunds f
                          WHERE f.tenant_id = d.tenant_id AND f.debit_note_id = d.id
                            AND f.date <= ${asOf}::date
                            AND (f.status = 'posted' OR f.void_date > ${asOf}::date)), 0)
      FROM debit_notes d
     WHERE d.tenant_id = ${tenantId}::uuid AND d.status = 'posted' AND d.date <= ${asOf}::date
       AND (d.applied + d.refunded < d.total
            OR EXISTS (SELECT 1 FROM debit_note_allocations a
                        WHERE a.tenant_id = d.tenant_id AND a.debit_note_id = d.id
                          AND a.applied_on > ${asOf}::date)
            OR EXISTS (SELECT 1 FROM supplier_refunds f
                        WHERE f.tenant_id = d.tenant_id AND f.debit_note_id = d.id
                          AND f.date > ${asOf}::date))`,
  groupColumn: sql`p.supplier_group_id`,
  isParty: sql`p.is_supplier`,
  account: 'payable',
};

// The buckets of decision 22 in SQL, the same edges as agingBucketOf() in the contract: current up
// to and on the due date, then 1–30, 31–60, 61–90 and over 90 days late. date − date is a whole
// number of days in Postgres, with no time zone in it.
function bucketSums(asOf: string): SQL {
  const late = sql`(${asOf}::date - d.due_date)`;
  return sql`
    sum(d.open) FILTER (WHERE ${late} <= 0) AS current,
    sum(d.open) FILTER (WHERE ${late} BETWEEN 1 AND 30) AS days1_to30,
    sum(d.open) FILTER (WHERE ${late} BETWEEN 31 AND 60) AS days31_to60,
    sum(d.open) FILTER (WHERE ${late} BETWEEN 61 AND 90) AS days61_to90,
    sum(d.open) FILTER (WHERE ${late} > 90) AS over90,
    sum(d.open) AS due`;
}

// r.<column>: the per-party numbers, not the SELECT's text of the same name (see the sorts in
// trade-report-queries.ts). Name, then id: two customers with one name keep their order.
const AGING_SORT_COLUMNS = {
  name: sql`lower(p.name)`,
  current: sql`r.current`,
  days1To30: sql`r.days1_to30`,
  days31To60: sql`r.days31_to60`,
  days61To90: sql`r.days61_to90`,
  over90: sql`r.over90`,
  due: sql`r.due`,
  advances: sql`r.advances`,
  balance: sql`r.balance`,
} satisfies Record<SortColumn<AgingSort>, SQL>;

const money = z.string();

const agingRowSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  current: money,
  days1_to30: money,
  days31_to60: money,
  days61_to90: money,
  over90: money,
  due: money,
  advances: money,
  balance: money,
  total_current: money,
  total_days1_to30: money,
  total_days31_to60: money,
  total_days61_to90: money,
  total_over90: money,
  total_due: money,
  total_advances: money,
  total_balance: money,
});

const ZERO = '0.0000';

// The query's filters, the same for both agings once the group is named
interface AgingFilter {
  asOf: string;
  show: 'all' | 'overdue';
  sort: AgingSort;
  groupId: string | undefined;
}

async function agingReport(
  tx: Transaction,
  side: AgingSide,
  filter: AgingFilter,
  page: ReportPage | null,
): Promise<AgingReport> {
  const tenantId = getTenantId();
  const sort = sortColumn(filter.sort, AGING_SORT_COLUMNS);
  const where: SQL[] = [sql`p.tenant_id = ${tenantId}::uuid`];
  if (filter.groupId !== undefined) where.push(sql`${side.groupColumn} = ${filter.groupId}::uuid`);
  // Anything past its due date: every bucket but Current. The whole row still shows.
  if (filter.show === 'overdue') where.push(sql`r.due - r.current > 0`);
  const found = await select(
    tx,
    sql`WITH documents AS (${side.documents(tenantId, filter.asOf)}),
        advances AS (${side.advances(tenantId, filter.asOf)}),
        owed AS (
          SELECT d.party_id, ${bucketSums(filter.asOf)}
            FROM documents d
           GROUP BY d.party_id
        ),
        held AS (
          SELECT a.party_id, sum(a.amount) AS advances
            FROM advances a
           WHERE a.amount > 0
           GROUP BY a.party_id
        ),
        r AS (
          SELECT coalesce(o.party_id, h.party_id) AS party_id,
                 coalesce(o.current, 0) AS current, coalesce(o.days1_to30, 0) AS days1_to30,
                 coalesce(o.days31_to60, 0) AS days31_to60, coalesce(o.days61_to90, 0) AS days61_to90,
                 coalesce(o.over90, 0) AS over90, coalesce(o.due, 0) AS due,
                 coalesce(h.advances, 0) AS advances,
                 coalesce(o.due, 0) - coalesce(h.advances, 0) AS balance
            FROM owed o
            FULL JOIN held h ON h.party_id = o.party_id
        )
        SELECT p.id, p.code, p.name,
               round(r.current, 4)::text AS current, round(r.days1_to30, 4)::text AS days1_to30,
               round(r.days31_to60, 4)::text AS days31_to60,
               round(r.days61_to90, 4)::text AS days61_to90, round(r.over90, 4)::text AS over90,
               round(r.due, 4)::text AS due, round(r.advances, 4)::text AS advances,
               round(r.balance, 4)::text AS balance,
               round(sum(r.current) OVER (), 4)::text AS total_current,
               round(sum(r.days1_to30) OVER (), 4)::text AS total_days1_to30,
               round(sum(r.days31_to60) OVER (), 4)::text AS total_days31_to60,
               round(sum(r.days61_to90) OVER (), 4)::text AS total_days61_to90,
               round(sum(r.over90) OVER (), 4)::text AS total_over90,
               round(sum(r.due) OVER (), 4)::text AS total_due,
               round(sum(r.advances) OVER (), 4)::text AS total_advances,
               round(sum(r.balance) OVER (), 4)::text AS total_balance
          FROM r
          JOIN parties p ON p.tenant_id = ${tenantId}::uuid AND p.id = r.party_id
         WHERE ${sql.join(where, sql` AND `)}
         ORDER BY ${sort.column} ${sort.direction}, lower(p.name), p.id
         ${pageClause(page)}`,
    agingRowSchema,
  );
  const first = found[0];
  const rows = pageRows(found, page);
  return {
    items: rows.items.map((row) => ({
      party: { id: row.id, code: row.code, name: row.name },
      current: row.current,
      days1To30: row.days1_to30,
      days31To60: row.days31_to60,
      days61To90: row.days61_to90,
      over90: row.over90,
      due: row.due,
      advances: row.advances,
      balance: row.balance,
    })),
    nextCursor: rows.nextCursor,
    asOf: filter.asOf,
    // No row: nothing owed and no advance, zeros
    totals: {
      current: first?.total_current ?? ZERO,
      days1To30: first?.total_days1_to30 ?? ZERO,
      days31To60: first?.total_days31_to60 ?? ZERO,
      days61To90: first?.total_days61_to90 ?? ZERO,
      over90: first?.total_over90 ?? ZERO,
      due: first?.total_due ?? ZERO,
      advances: first?.total_advances ?? ZERO,
      balance: first?.total_balance ?? ZERO,
    },
    // The books know no due dates: nothing to compare "overdue only" with (decision 22)
    ledger:
      filter.show === 'overdue'
        ? null
        : await ledgerBalance(tx, side, filter.asOf, {
            groupId: filter.groupId,
            partyId: undefined,
          }),
  };
}

// The control account's balance at the end of D, in the report's sense: the receivable's debit −
// credit, the payable's credit − debit. From the journal's lines, not account_day_totals: only the
// lines carry the party (step 15a), which the group filter and a party's page need. The lines of one
// account up to a day are read by journal_lines_tenant_account_idx.
async function ledgerBalance(
  tx: Transaction,
  side: AgingSide,
  asOf: string,
  of: { groupId: string | undefined; partyId: string | undefined },
): Promise<string> {
  const books = await loadBooks(tx);
  const accountId =
    side.account === 'receivable' ? books.receivableAccountId : books.payableAccountId;
  if (accountId === null) return ZERO;
  const tenantId = getTenantId();
  const amount = side.account === 'receivable' ? sql`l.debit - l.credit` : sql`l.credit - l.debit`;
  const [row] = await select(
    tx,
    sql`SELECT round(coalesce(sum(${amount}), 0), 4)::text AS balance
          FROM journal_lines l
          JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
          ${of.groupId === undefined ? sql`` : sql`JOIN parties p ON p.tenant_id = l.tenant_id AND p.id = l.party_id`}
         WHERE l.tenant_id = ${tenantId}::uuid AND l.account_id = ${accountId}::uuid
           AND e.status = 'posted' AND e.date <= ${asOf}::date
           ${of.groupId === undefined ? sql`` : sql`AND ${side.groupColumn} = ${of.groupId}::uuid`}
           ${of.partyId === undefined ? sql`` : sql`AND l.party_id = ${of.partyId}::uuid`}`,
    z.object({ balance: z.string() }),
  );
  return row?.balance ?? ZERO;
}

export function receivablesAging(
  tx: Transaction,
  filter: ArAgingFilter,
  page: ReportPage | null,
): Promise<AgingReport> {
  return agingReport(tx, RECEIVABLES, { ...filter, groupId: filter.customerGroupId }, page);
}

export function payablesAging(
  tx: Transaction,
  filter: ApAgingFilter,
  page: ReportPage | null,
): Promise<AgingReport> {
  return agingReport(tx, PAYABLES, { ...filter, groupId: filter.supplierGroupId }, page);
}

// ---------------------------------------------------------------------------------------------
// One party's page (decision 23): its open documents, the oldest due date first, and its
// advances, the oldest first. Not paged.

const documentRowSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  due_date: z.iso.date(),
  total: z.string(),
  open: z.string(),
  supplier_bill_number: z.string().nullable(),
});

function advanceRowSchema<K extends readonly [string, ...string[]]>(kinds: K) {
  return z.object({
    id: z.uuid(),
    kind: z.enum(kinds),
    number: z.string(),
    date: z.iso.date(),
    amount: z.string(),
  });
}

// The party, if it is one of this aging's: a supplier is not found on the receivables' page
async function partyOf(
  tx: Transaction,
  side: AgingSide,
  partyId: string,
): Promise<PartyRef | null> {
  const [party] = await select(
    tx,
    sql`SELECT p.id, p.code, p.name FROM parties p
         WHERE p.tenant_id = ${getTenantId()}::uuid AND p.id = ${partyId}::uuid AND ${side.isParty}`,
    z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  );
  return party ?? null;
}

async function partyRows<S extends z.ZodType>(
  tx: Transaction,
  side: AgingSide,
  partyId: string,
  asOf: string,
  advanceRow: S,
): Promise<{ documents: z.output<typeof documentRowSchema>[]; advances: z.output<S>[] }> {
  const tenantId = getTenantId();
  const [documents, advances] = await Promise.all([
    select(
      tx,
      sql`SELECT d.id, d.number, d.date::text AS date, d.due_date::text AS due_date,
                 round(d.total, 4)::text AS total, round(d.open, 4)::text AS open,
                 d.supplier_bill_number
            FROM (${side.documents(tenantId, asOf)}) d
           WHERE d.party_id = ${partyId}::uuid
           ORDER BY d.due_date, d.date, d.number`,
      documentRowSchema,
    ),
    select(
      tx,
      sql`SELECT a.id, a.kind, a.number, a.date::text AS date, round(a.amount, 4)::text AS amount
            FROM (${side.advances(tenantId, asOf)}) a
           WHERE a.party_id = ${partyId}::uuid AND a.amount > 0
           ORDER BY a.date, a.number`,
      advanceRow,
    ),
  ]);
  return { documents, advances };
}

// bills.supplier_bill_number is NOT NULL; the column is nullable here only because an invoice
// has none. A bill without one would be a broken row, not something to show as ''.
function supplierBillNumber(row: z.output<typeof documentRowSchema>): string {
  if (row.supplier_bill_number === null) throw new Error(`Bill ${row.id} has no supplier number`);
  return row.supplier_bill_number;
}

function documentOf(row: z.output<typeof documentRowSchema>, asOf: string) {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    dueDate: row.due_date,
    total: row.total,
    open: row.open,
    daysOverdue: daysOverdue(row.due_date, asOf),
    bucket: agingBucketOf(row.due_date, asOf),
  };
}

// The party's row of the report, worked out by the contract's agingAmountsOf() from the same
// documents: the mock does the same, and 21b.4 checks it against the report's SQL buckets
function totalsOf(
  documents: readonly z.output<typeof documentRowSchema>[],
  advances: readonly { amount: string }[],
  asOf: string,
) {
  return agingAmountsOf(
    documents.map((row) => ({ dueDate: row.due_date, open: row.open })),
    advances.map((row) => row.amount),
    asOf,
  );
}

export async function receivablesOf(
  tx: Transaction,
  customerId: string,
  asOf: string,
): Promise<ArAgingParty> {
  const party = await partyOf(tx, RECEIVABLES, customerId);
  if (party === null) throw notFound('Customer');
  const { documents, advances } = await partyRows(
    tx,
    RECEIVABLES,
    customerId,
    asOf,
    advanceRowSchema(AR_ADVANCE_KINDS),
  );
  return {
    asOf,
    party,
    totals: totalsOf(documents, advances, asOf),
    ledger: await ledgerBalance(tx, RECEIVABLES, asOf, { groupId: undefined, partyId: customerId }),
    documents: documents.map((row) => documentOf(row, asOf)),
    advances,
  };
}

export async function payablesOf(
  tx: Transaction,
  supplierId: string,
  asOf: string,
): Promise<ApAgingParty> {
  const party = await partyOf(tx, PAYABLES, supplierId);
  if (party === null) throw notFound('Supplier');
  const { documents, advances } = await partyRows(
    tx,
    PAYABLES,
    supplierId,
    asOf,
    advanceRowSchema(AP_ADVANCE_KINDS),
  );
  return {
    asOf,
    party,
    totals: totalsOf(documents, advances, asOf),
    ledger: await ledgerBalance(tx, PAYABLES, asOf, { groupId: undefined, partyId: supplierId }),
    documents: documents.map((row) => ({
      ...documentOf(row, asOf),
      supplierBillNumber: supplierBillNumber(row),
    })),
    advances,
  };
}
