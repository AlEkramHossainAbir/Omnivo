import {
  subtractMoney,
  TAX_RATE_KINDS,
  type VatDocumentPage,
  type VatReport,
  type VatReportFilter,
  type VatReportSide,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { pageClause, pageRows, type ReportPage, select } from './report-paging.js';

// The VAT report (step 21c), in plain SQL like the 21b reports, so the page and the export run
// the same queries. Every line keeps a copy of the rate it was charged at (name, kind, percent),
// so the rows come from that copy (decision 14), never from the tax_rates table as it is today.

// Every line with VAT in the period, one row each (decision 1), signed so that adding them up gives
// the period: a sale or a bill adds, a credit note, a POS return or a debit note takes off.
// `returned` marks the lines that take off. `mushak` is the supplier's VAT document: a bill's 6.3,
// a debit note's 6.7. A branch as decision 19 says: an invoice's and a bill's own, a credit note's
// invoice's, a POS document's warehouse's.
function vatLines(tenantId: string, from: string, to: string): SQL {
  return sql`
    SELECT 'output' AS side, 'invoice' AS kind, i.id AS doc_id, i.number, i.date,
           i.customer_id AS party_id, i.branch_id, NULL::text AS mushak, false AS returned,
           l.tax_rate_id, l.tax_rate_name, l.tax_rate_kind, l.tax_rate, l.net, l.vat
      FROM invoice_lines l
      JOIN invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
     WHERE l.tenant_id = ${tenantId}::uuid AND i.status = 'posted'
       AND i.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'output', 'pos_sale', s.id, s.number, s.date, s.customer_id, w.branch_id, NULL, false,
           l.tax_rate_id, l.tax_rate_name, l.tax_rate_kind, l.tax_rate, l.net, l.vat
      FROM pos_sale_lines l
      JOIN pos_sales s ON s.tenant_id = l.tenant_id AND s.id = l.sale_id
      JOIN warehouses w ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
     WHERE l.tenant_id = ${tenantId}::uuid AND s.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'output', 'credit_note', c.id, c.number, c.date, c.customer_id, i.branch_id, NULL, true,
           l.tax_rate_id, l.tax_rate_name, l.tax_rate_kind, l.tax_rate, -l.net, -l.vat
      FROM credit_note_lines l
      JOIN credit_notes c ON c.tenant_id = l.tenant_id AND c.id = l.credit_note_id
      JOIN invoices i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
     WHERE l.tenant_id = ${tenantId}::uuid AND c.status = 'posted'
       AND c.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    -- A POS return line has no rate of its own: it is the sale line's
    SELECT 'output', 'pos_return', r.id, r.number, r.date, s.customer_id, w.branch_id, NULL, true,
           sl.tax_rate_id, sl.tax_rate_name, sl.tax_rate_kind, sl.tax_rate, -l.net, -l.vat
      FROM pos_return_lines l
      JOIN pos_returns r ON r.tenant_id = l.tenant_id AND r.id = l.return_id
      JOIN pos_sales s ON s.tenant_id = r.tenant_id AND s.id = r.sale_id
      JOIN pos_sale_lines sl ON sl.tenant_id = l.tenant_id AND sl.id = l.sale_line_id
      JOIN warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id
     WHERE l.tenant_id = ${tenantId}::uuid AND r.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'input', 'bill', b.id, b.number, b.date, b.supplier_id, b.branch_id, b.mushak_number,
           false, l.tax_rate_id, l.tax_rate_name, l.tax_rate_kind, l.tax_rate, l.net, l.vat
      FROM bill_lines l
      JOIN bills b ON b.tenant_id = l.tenant_id AND b.id = l.bill_id
     WHERE l.tenant_id = ${tenantId}::uuid AND b.status = 'posted'
       AND b.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'input', 'bill', b.id, b.number, b.date, b.supplier_id, b.branch_id, b.mushak_number,
           false, e.tax_rate_id, e.tax_rate_name, e.tax_rate_kind, e.tax_rate, e.net, e.vat
      FROM bill_expenses e
      JOIN bills b ON b.tenant_id = e.tenant_id AND b.id = e.bill_id
     WHERE e.tenant_id = ${tenantId}::uuid AND b.status = 'posted'
       AND b.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'input', 'debit_note', d.id, d.number, d.date, d.supplier_id, d.branch_id,
           d.supplier_credit_number, true,
           l.tax_rate_id, l.tax_rate_name, l.tax_rate_kind, l.tax_rate, -l.net, -l.vat
      FROM debit_note_lines l
      JOIN debit_notes d ON d.tenant_id = l.tenant_id AND d.id = l.debit_note_id
     WHERE l.tenant_id = ${tenantId}::uuid AND d.status = 'posted'
       AND d.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'input', 'debit_note', d.id, d.number, d.date, d.supplier_id, d.branch_id,
           d.supplier_credit_number, true,
           e.tax_rate_id, e.tax_rate_name, e.tax_rate_kind, e.tax_rate, -e.net, -e.vat
      FROM debit_note_expenses e
      JOIN debit_notes d ON d.tenant_id = e.tenant_id AND d.id = e.debit_note_id
     WHERE e.tenant_id = ${tenantId}::uuid AND d.status = 'posted'
       AND d.date BETWEEN ${from}::date AND ${to}::date`;
}

function branchWhere(branchId: string | undefined): SQL {
  return branchId === undefined ? sql`` : sql`WHERE l.branch_id = ${branchId}::uuid`;
}

const ZERO = '0.0000';

const rateRowSchema = z.object({
  tax_rate_id: z.uuid(),
  kind: z.enum(TAX_RATE_KINDS),
  rate: z.string(),
  name: z.string(),
  output_net: z.string(),
  output_vat: z.string(),
  input_net: z.string(),
  input_vat: z.string(),
});

const totalsSchema = z.object({
  output_net: z.string(),
  output_vat: z.string(),
  output_vat_returned: z.string(),
  input_net: z.string(),
  input_vat: z.string(),
  input_vat_returned: z.string(),
  input_vat_without_mushak: z.string(),
  net_vat: z.string(),
});

// The order of a return (decision 15): standard rates first, then reduced, zero-rated, exempt
const KIND_ORDER = sql`CASE g.kind WHEN 'standard' THEN 0 WHEN 'reduced' THEN 1
                                   WHEN 'zero_rated' THEN 2 ELSE 3 END`;

// One query for the rows, one for the totals: both read the same lines, and the totals need the
// returned and the "no Mushak 6.3" parts, which belong to no row
export async function vatReport(tx: Transaction, filter: VatReportFilter): Promise<VatReport> {
  const tenantId = getTenantId();
  const lines = vatLines(tenantId, filter.from, filter.to);
  const where = branchWhere(filter.branchId);
  const [rows, [totals], books] = await Promise.all([
    select(
      tx,
      sql`WITH lines AS (${lines}),
          grouped AS (
            SELECT l.tax_rate_id, l.tax_rate_kind AS kind, l.tax_rate AS rate,
                   -- The name the latest line used: a rate renamed in the period shows its new name
                   (array_agg(l.tax_rate_name ORDER BY l.date DESC, l.doc_id DESC))[1] AS name,
                   coalesce(sum(l.net) FILTER (WHERE l.side = 'output'), 0) AS output_net,
                   coalesce(sum(l.vat) FILTER (WHERE l.side = 'output'), 0) AS output_vat,
                   coalesce(sum(l.net) FILTER (WHERE l.side = 'input'), 0) AS input_net,
                   coalesce(sum(l.vat) FILTER (WHERE l.side = 'input'), 0) AS input_vat
              FROM lines l
              ${where}
             GROUP BY l.tax_rate_id, l.tax_rate_kind, l.tax_rate
          )
          SELECT g.tax_rate_id, g.kind, g.rate::text AS rate, g.name,
                 round(g.output_net, 4)::text AS output_net, round(g.output_vat, 4)::text AS output_vat,
                 round(g.input_net, 4)::text AS input_net, round(g.input_vat, 4)::text AS input_vat
            FROM grouped g
           ORDER BY ${KIND_ORDER}, g.rate DESC, lower(g.name), g.tax_rate_id`,
      rateRowSchema,
    ),
    // sum() of no rows is NULL, so every total has its coalesce: an empty month is zeros
    select(
      tx,
      sql`WITH lines AS (${lines})
          SELECT round(coalesce(sum(l.net) FILTER (WHERE l.side = 'output'), 0), 4)::text AS output_net,
                 round(coalesce(sum(l.vat) FILTER (WHERE l.side = 'output'), 0), 4)::text AS output_vat,
                 round(coalesce(-sum(l.vat) FILTER (WHERE l.side = 'output' AND l.returned), 0), 4)::text
                   AS output_vat_returned,
                 round(coalesce(sum(l.net) FILTER (WHERE l.side = 'input'), 0), 4)::text AS input_net,
                 round(coalesce(sum(l.vat) FILTER (WHERE l.side = 'input'), 0), 4)::text AS input_vat,
                 round(coalesce(-sum(l.vat) FILTER (WHERE l.side = 'input' AND l.returned), 0), 4)::text
                   AS input_vat_returned,
                 -- Bills only, before the debit notes (decision 17)
                 round(coalesce(sum(l.vat) FILTER (WHERE l.kind = 'bill' AND l.mushak IS NULL), 0), 4)::text
                   AS input_vat_without_mushak,
                 round(coalesce(sum(CASE WHEN l.side = 'output' THEN l.vat ELSE -l.vat END), 0), 4)::text
                   AS net_vat
            FROM lines l
            ${where}`,
      totalsSchema,
    ),
    booksVat(tx, filter),
  ]);
  return {
    rows: rows.map((row) => ({
      // The kind is in the key too: an exempt rate changed to zero-rated is two rows (decision 14)
      key: `${row.tax_rate_id}:${row.kind}:${row.rate}`,
      taxRateId: row.tax_rate_id,
      name: row.name,
      kind: row.kind,
      rate: row.rate,
      outputNet: row.output_net,
      outputVat: row.output_vat,
      inputNet: row.input_net,
      inputVat: row.input_vat,
      netVat: subtractMoney(row.output_vat, row.input_vat),
    })),
    totals: {
      outputNet: totals?.output_net ?? ZERO,
      outputVat: totals?.output_vat ?? ZERO,
      outputVatReturned: totals?.output_vat_returned ?? ZERO,
      inputNet: totals?.input_net ?? ZERO,
      inputVat: totals?.input_vat ?? ZERO,
      inputVatReturned: totals?.input_vat_returned ?? ZERO,
      inputVatWithoutMushak: totals?.input_vat_without_mushak ?? ZERO,
      netVat: totals?.net_vat ?? ZERO,
    },
    books,
  };
}

// What the books moved on the VAT accounts in the same period and branch: output is credit less
// debit on 'vat_output', input debit less credit on 'vat_input', from account_day_totals (step 21a)
async function booksVat(
  tx: Transaction,
  filter: VatReportFilter,
): Promise<{ output: string; input: string }> {
  const [row] = await select(
    tx,
    sql`SELECT round(coalesce(sum(t.credit - t.debit) FILTER (WHERE a.purpose = 'vat_output'), 0), 4)::text
                 AS output,
               round(coalesce(sum(t.debit - t.credit) FILTER (WHERE a.purpose = 'vat_input'), 0), 4)::text
                 AS input
          FROM account_day_totals t
          JOIN ledger_accounts a ON a.tenant_id = t.tenant_id AND a.id = t.account_id
         WHERE t.tenant_id = ${getTenantId()}::uuid
           AND a.purpose IN ('vat_output', 'vat_input')
           AND t.day BETWEEN ${filter.from}::date AND ${filter.to}::date
           ${filter.branchId === undefined ? sql`` : sql`AND t.branch_id = ${filter.branchId}::uuid`}`,
    z.object({ output: z.string(), input: z.string() }),
  );
  return { output: row?.output ?? ZERO, input: row?.input ?? ZERO };
}

const documentRowSchema = z.object({
  kind: z.string(),
  id: z.uuid(),
  number: z.string(),
  date: z.string(),
  party_name: z.string().nullable(),
  party_bin: z.string().nullable(),
  mushak: z.string().nullable(),
  net: z.string(),
  vat: z.string(),
});

// The documents behind one side, oldest first, like a VAT register on paper (decision 18). One row
// per document: its lines added up, with the same sign as in the report.
export async function vatDocuments(
  tx: Transaction,
  filter: VatReportFilter & { side: VatReportSide },
  page: ReportPage | null,
): Promise<VatDocumentPage> {
  const tenantId = getTenantId();
  const conditions = [sql`l.side = ${filter.side}`];
  if (filter.branchId !== undefined) conditions.push(sql`l.branch_id = ${filter.branchId}::uuid`);
  const found = await select(
    tx,
    sql`WITH lines AS (${vatLines(tenantId, filter.from, filter.to)})
        SELECT l.kind, l.doc_id AS id, coalesce(l.number, '') AS number, l.date::text AS date,
               p.name AS party_name, p.bin AS party_bin, l.mushak AS mushak,
               round(sum(l.net), 4)::text AS net, round(sum(l.vat), 4)::text AS vat
          FROM lines l
          LEFT JOIN parties p ON p.tenant_id = ${tenantId}::uuid AND p.id = l.party_id
         WHERE ${sql.join(conditions, sql` AND `)}
         GROUP BY l.kind, l.doc_id, l.number, l.date, p.id, l.mushak
         -- The id last: two documents of one day keep their order from page to page
         ORDER BY l.date, l.number, l.doc_id
         ${pageClause(page)}`,
    documentRowSchema,
  );
  const rows = pageRows(found, page);
  return {
    items: rows.items.map((row) => ({
      kind: row.kind,
      id: row.id,
      number: row.number,
      date: row.date,
      partyName: row.party_name,
      partyBin: row.party_bin,
      mushakNumber: row.mushak,
      net: row.net,
      vat: row.vat,
    })),
    nextCursor: rows.nextCursor,
  };
}
