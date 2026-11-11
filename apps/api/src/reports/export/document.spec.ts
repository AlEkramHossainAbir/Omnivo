import {
  type AgingAmounts,
  type AgingReport,
  type BalanceSheet,
  costColumns,
  type PurchaseReport,
  type ReportSection,
  type SalesReport,
  type SalesReportRow,
  type StockMovementReport,
  type StockMovementRow,
  type TrialBalance,
  type VatReport,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { buildDocument, type DocCell, type DocumentContext, fileStem } from './document.js';

const context: DocumentContext = {
  language: 'en',
  company: 'Rahman Garments Ltd.',
  currency: 'BDT',
  timeZone: 'Asia/Dhaka',
  branchName: null,
  groupName: null,
  categoryName: null,
  warehouseName: null,
  madeAt: new Date('2026-10-01T08:05:00Z'),
};

// A cell as it reads: the text, the amount, or '' for an empty cell
function read(cell: DocCell | undefined): string {
  if (cell === undefined || cell.kind === 'empty') return '';
  return cell.kind === 'money' ? cell.amount : cell.text;
}

const id = (n: number) => `01939d1c-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('the document of a trial balance', () => {
  const data: TrialBalance = {
    rows: [
      {
        accountId: id(1),
        code: '1110',
        name: 'Cash in hand',
        type: 'asset',
        opening: '0.0000',
        debit: '0.0000',
        credit: '185000.0000',
        closing: '-185000.0000',
      },
    ],
    totals: {
      openingDebit: '0.0000',
      openingCredit: '0.0000',
      debit: '0.0000',
      credit: '185000.0000',
      closingDebit: '0.0000',
      closingCredit: '185000.0000',
    },
  };

  it('puts a balance in its Dr or Cr column, and leaves what did not move empty', () => {
    const doc = buildDocument(
      { report: 'trial_balance', query: { from: '2026-07-01', to: '2026-09-30' }, data },
      context,
    );
    expect(doc.landscape).toBe(true);
    expect(doc.rows[0]?.cells.map(read)).toEqual([
      '1110',
      'Cash in hand',
      '',
      '',
      '',
      '185000.0000',
      '',
      '185000.0000',
    ]);
    expect(doc.lines).toEqual([
      '1 Jul 2026 – 30 Sep 2026',
      'Amounts in BDT',
      'Made on 1 Oct 2026, 14:05',
    ]);
  });

  it('names the file by the report and its dates, in ASCII', () => {
    expect(
      fileStem({ report: 'trial_balance', query: { from: '2026-07-01', to: '2026-09-30' }, data }),
    ).toBe('trial-balance-2026-07-01-to-2026-09-30');
  });
});

describe('the document of a balance sheet', () => {
  const section = (type: ReportSection['type'], total: string): ReportSection => ({
    type,
    rows: [],
    total,
    compareTotal: null,
  });
  const data: BalanceSheet = {
    asset: section('asset', '965000.0000'),
    liability: section('liability', '0.0000'),
    equity: section('equity', '0.0000'),
    profitNotClosed: '965000.0000',
    compareProfitNotClosed: null,
    liabilitiesAndEquity: '965000.0000',
    compareLiabilitiesAndEquity: null,
  };

  it('ends equity with the profit not closed yet, inside the equity total', () => {
    const doc = buildDocument(
      { report: 'balance_sheet', query: { asOf: '2026-09-30' }, data },
      { ...context, language: 'bn' },
    );
    expect(doc.title).toBe('ব্যালান্স শিট');
    expect(doc.rows.slice(-3).map((row) => [row.style, ...row.cells.map(read)])).toEqual([
      ['normal', 'যে লাভ এখনো রিটেইনড আর্নিংসে যায়নি', '965000.0000'],
      ['total', 'মোট মালিকানা স্বত্ব', '965000.0000'],
      ['grand', 'মোট দায় ও মালিকানা স্বত্ব', '965000.0000'],
    ]);
  });
});

// Step 21b: the sales and purchase reports and the agings

// A sales row: an item unless a kind is given; the cost columns from the net and the cost
function salesRow(
  name: string | null,
  amounts: { gross: string; returns: string; net: string; cost: string | null },
  extra: Partial<SalesReportRow> = {},
): SalesReportRow {
  return {
    key: name ?? 'walk_in',
    kind: 'item',
    id: null,
    code: null,
    name,
    month: null,
    quantity: null,
    baseUnit: null,
    gross: amounts.gross,
    returns: amounts.returns,
    net: amounts.net,
    ...costColumns(amounts.net, amounts.cost),
    ...extra,
  };
}

function salesReport(
  items: SalesReportRow[],
  withCost: boolean,
  books: string | null,
): SalesReport {
  return {
    items,
    nextCursor: null,
    totals: {
      gross: '5035.0000',
      returns: '331.0000',
      net: '4704.0000',
      ...costColumns('4704.0000', withCost ? '4111.0000' : null),
    },
    withCost,
    books,
  };
}

describe('the document of a sales report', () => {
  const query = {
    from: '2026-09-06',
    to: '2026-11-05',
    groupBy: 'customer' as const,
    sort: '-net' as const,
  };
  const rahim = { gross: '3600.0000', returns: '100.0000', net: '3500.0000', cost: '3040.0000' };
  const walkIns = { gross: '580.0000', returns: '60.0000', net: '520.0000', cost: '431.0000' };

  it('writes the code before the name, the walk-ins in words, and the cost when allowed', () => {
    const data = salesReport(
      [
        salesRow('Rahim Traders', rahim, { code: 'C-00001' }),
        salesRow(null, walkIns, { kind: 'walk_in' }),
      ],
      true,
      '5204.0000',
    );
    const doc = buildDocument({ report: 'sales_report', query, data }, context);
    expect(doc.title).toBe('Sales report');
    // Seven columns do not fit a portrait page
    expect(doc.landscape).toBe(true);
    expect(doc.columns.map((column) => [column.header, column.kind])).toEqual([
      ['Customer', 'text'],
      ['Sold', 'money'],
      ['Returns', 'money'],
      ['Net sales', 'money'],
      ['Cost', 'money'],
      ['Margin', 'money'],
      ['Margin %', 'number'],
    ]);
    expect(doc.rows.map((row) => [row.style, ...row.cells.map(read)])).toEqual([
      [
        'normal',
        'C-00001 Rahim Traders',
        '3600.0000',
        '100.0000',
        '3500.0000',
        '3040.0000',
        '460.0000',
        '13.1%',
      ],
      [
        'normal',
        'Walk-in customers',
        '580.0000',
        '60.0000',
        '520.0000',
        '431.0000',
        '89.0000',
        '17.1%',
      ],
      ['grand', 'Total', '5035.0000', '331.0000', '4704.0000', '4111.0000', '593.0000', '12.6%'],
    ]);
    // The books' figure under the period, to compare with the total
    expect(doc.lines).toEqual([
      '6 Sep 2026 – 5 Nov 2026',
      'By customer',
      'In the books: 5,204.00',
      'Amounts in BDT',
      'Made on 1 Oct 2026, 14:05',
    ]);
  });

  it('leaves the cost out of the file of someone who may not see it', () => {
    const data = salesReport([salesRow('Rahim Traders', { ...rahim, cost: null })], false, null);
    const doc = buildDocument({ report: 'sales_report', query, data }, context);
    expect(doc.landscape).toBe(false);
    expect(doc.columns.map((column) => column.header)).toEqual([
      'Customer',
      'Sold',
      'Returns',
      'Net sales',
    ]);
    expect(doc.rows.every((row) => row.cells.length === 4)).toBe(true);
    // With a customer group there is no books' figure
    expect(doc.lines).not.toContain('In the books: 5,204.00');
  });

  it('writes a quantity with its unit, by product, and adds none up', () => {
    const data = salesReport(
      [
        salesRow('Miniket rice 5 kg', rahim, {
          code: 'P-00001',
          quantity: '1250.0000',
          baseUnit: { code: 'pcs', decimals: 0 },
        }),
      ],
      false,
      '4704.0000',
    );
    const doc = buildDocument(
      { report: 'sales_report', query: { ...query, groupBy: 'product' }, data },
      { ...context, branchName: 'Mirpur shop', categoryName: 'Rice' },
    );
    expect(doc.landscape).toBe(true);
    expect(doc.columns[1]).toMatchObject({ header: 'Quantity', kind: 'number' });
    expect(doc.rows.map((row) => row.cells.slice(0, 2).map(read))).toEqual([
      ['P-00001 Miniket rice 5 kg', '1,250 pcs'],
      ['Total', ''],
    ]);
    expect(doc.lines.slice(0, 4)).toEqual([
      '6 Sep 2026 – 5 Nov 2026',
      'By product',
      'Branch: Mirpur shop',
      'Category: Rice',
    ]);
  });

  it('names a month, in Bangla too', () => {
    const data = salesReport(
      [salesRow(null, rahim, { key: '2026-10', month: '2026-10' })],
      false,
      null,
    );
    const ofMonths = {
      report: 'sales_report' as const,
      query: { ...query, groupBy: 'month' as const },
      data,
    };
    expect(read(buildDocument(ofMonths, context).rows[0]?.cells[0])).toBe('October 2026');
    expect(read(buildDocument(ofMonths, { ...context, language: 'bn' }).rows[0]?.cells[0])).toBe(
      'অক্টোবর ২০২৬',
    );
    expect(fileStem(ofMonths)).toBe('sales-2026-09-06-to-2026-11-05');
  });
});

describe('the document of a purchase report', () => {
  const data: PurchaseReport = {
    items: [
      {
        key: 'products',
        kind: 'products',
        id: null,
        code: null,
        name: null,
        month: null,
        quantity: null,
        baseUnit: null,
        gross: '2500.0000',
        returns: '370.0000',
        net: '2130.0000',
      },
    ],
    nextCursor: null,
    totals: { gross: '2500.0000', returns: '370.0000', net: '2130.0000' },
  };

  it('has no cost and no books, and names the Products row in words', () => {
    const report = {
      report: 'purchase_report' as const,
      query: {
        from: '2026-09-06',
        to: '2026-11-05',
        groupBy: 'account' as const,
        sort: '-net' as const,
      },
      data,
    };
    const doc = buildDocument(report, { ...context, groupName: 'Local mills' });
    expect(doc.landscape).toBe(false);
    expect(doc.columns.map((column) => column.header)).toEqual([
      'Expense account',
      'Billed',
      'Debit notes',
      'Net purchases',
    ]);
    expect(doc.rows.map((row) => row.cells.map(read))).toEqual([
      ['Products', '2500.0000', '370.0000', '2130.0000'],
      ['Total', '2500.0000', '370.0000', '2130.0000'],
    ]);
    expect(doc.lines.slice(0, 3)).toEqual([
      '6 Sep 2026 – 5 Nov 2026',
      'By expense account',
      'Supplier group: Local mills',
    ]);
    expect(fileStem(report)).toBe('purchases-2026-09-06-to-2026-11-05');
  });
});

describe('the document of an aging', () => {
  const amounts = (balance: string): AgingAmounts => ({
    current: '100.0000',
    days1To30: '500.0000',
    days31To60: '900.0000',
    days61To90: '1300.0000',
    over90: '800.0000',
    due: '3600.0000',
    advances: '0.0000',
    balance,
  });
  const data = (ledger: string | null): AgingReport => ({
    items: [
      {
        party: { id: id(7), code: 'C-00007', name: 'Agrabad Medicine Corner' },
        ...amounts('3600.0000'),
      },
    ],
    nextCursor: null,
    asOf: '2026-11-05',
    totals: amounts('3600.0000'),
    ledger,
  });

  // "As at", the balance sheet's words for a picture of one day
  it("has the page's nine columns, the day and the ledger's figure", () => {
    const report = {
      report: 'ar_aging' as const,
      query: { asOf: '2026-11-05', show: 'all' as const, sort: '-balance' as const },
      data: data('3600.0000'),
    };
    const doc = buildDocument(report, context);
    expect(doc.title).toBe('Receivables aging');
    expect(doc.landscape).toBe(true);
    expect(doc.columns.map((column) => column.header)).toEqual([
      'Customer',
      'Current',
      '1–30 days',
      '31–60 days',
      '61–90 days',
      'Over 90 days',
      'Total due',
      'Advances',
      'Balance',
    ]);
    expect(doc.rows[0]?.cells.map(read)).toEqual([
      'C-00007 Agrabad Medicine Corner',
      '100.0000',
      '500.0000',
      '900.0000',
      '1300.0000',
      '800.0000',
      '3600.0000',
      '0.0000',
      '3600.0000',
    ]);
    expect(doc.lines.slice(0, 2)).toEqual(['As at 5 Nov 2026', 'In the books: 3,600.00']);
    expect(fileStem(report)).toBe('receivables-aging-2026-11-05');
  });

  it('says "Overdue only", with no ledger to compare, for the suppliers too', () => {
    const report = {
      report: 'ap_aging' as const,
      query: { asOf: '2026-11-05', show: 'overdue' as const, sort: '-balance' as const },
      data: data(null),
    };
    const doc = buildDocument(report, { ...context, groupName: 'Yarn mills' });
    expect(doc.title).toBe('Payables aging');
    expect(doc.columns[0]?.header).toBe('Supplier');
    expect(doc.lines.slice(0, 3)).toEqual([
      'As at 5 Nov 2026',
      'Supplier group: Yarn mills',
      'Overdue only',
    ]);
    expect(doc.lines.some((line) => line.startsWith('In the books'))).toBe(false);
    expect(fileStem(report)).toBe('payables-aging-2026-11-05');
  });
});

describe('the document of a VAT report', () => {
  const rate = (name: string, kind: 'standard' | 'exempt', percent: string) => ({
    key: `${id(1)}:${kind}:${percent}`,
    taxRateId: id(1),
    name,
    kind,
    rate: percent,
  });
  const data: VatReport = {
    rows: [
      {
        ...rate('VAT 15%', 'standard', '15.00'),
        outputNet: '4704.0000',
        outputVat: '705.6000',
        inputNet: '2430.0000',
        inputVat: '364.5000',
        netVat: '341.1000',
      },
      {
        ...rate('Exempt', 'exempt', '0.00'),
        outputNet: '0.0000',
        outputVat: '0.0000',
        inputNet: '11000.0000',
        inputVat: '0.0000',
        netVat: '0.0000',
      },
    ],
    totals: {
      outputNet: '4704.0000',
      outputVat: '705.6000',
      outputVatReturned: '49.6500',
      inputNet: '13430.0000',
      inputVat: '364.5000',
      inputVatReturned: '55.5000',
      inputVatWithoutMushak: '420.0000',
      netVat: '341.1000',
    },
    books: { output: '705.6000', input: '364.5000' },
  };
  const query = { from: '2026-10-01', to: '2026-10-31' };

  it("has a row per rate with the rate's name and percent, the total, and the books", () => {
    const doc = buildDocument(
      { report: 'vat_report', query, data },
      { ...context, branchName: 'Agrabad depot' },
    );
    expect(doc.landscape).toBe(true);
    expect(doc.columns.map((column) => column.header)).toEqual([
      'VAT rate',
      'Sales before VAT',
      'Output VAT',
      'Purchases before VAT',
      'Input VAT',
      'Net VAT',
    ]);
    expect(doc.rows.map((row) => row.cells.map(read))).toEqual([
      ['VAT 15% · 15%', '4704.0000', '705.6000', '2430.0000', '364.5000', '341.1000'],
      ['Exempt · 0%', '0.0000', '0.0000', '11000.0000', '0.0000', '0.0000'],
      ['Total', '4704.0000', '705.6000', '13430.0000', '364.5000', '341.1000'],
    ]);
    expect(doc.rows.at(-1)?.style).toBe('grand');
    expect(doc.lines).toEqual([
      '1 Oct 2026 – 31 Oct 2026',
      'Branch: Agrabad depot',
      'In the books: output VAT 705.60, input VAT 364.50',
      'Taken off: 49.65 output VAT (credit notes and POS returns), 55.50 input VAT (debit notes)',
      'Input VAT on bills with no Mushak 6.3: 420.00',
      'Amounts in BDT',
      'Made on 1 Oct 2026, 14:05',
    ]);
    expect(fileStem({ report: 'vat_report', query, data })).toBe('vat-2026-10-01-to-2026-10-31');
  });

  it('leaves out the lines of zeros, and writes Bangla digits in Bangla', () => {
    const quiet: VatReport = {
      ...data,
      totals: {
        ...data.totals,
        outputVatReturned: '0.0000',
        inputVatReturned: '0.0000',
        inputVatWithoutMushak: '0.0000',
      },
    };
    const doc = buildDocument(
      { report: 'vat_report', query, data: quiet },
      { ...context, language: 'bn' },
    );
    // The dates, the books, then the currency and the time: no "taken off", no "no 6.3"
    expect(doc.lines).toHaveLength(4);
    expect(doc.lines[1]).toBe('হিসাবের খাতায়: আউটপুট VAT ৭০৫.৬০, ইনপুট VAT ৩৬৪.৫০');
    // The rate's own name stays as the workspace wrote it; the percent is in Bangla digits
    expect(doc.rows[0]?.cells.map(read)[0]).toBe('VAT 15% · ১৫%');
  });
});

describe('the document of a stock movement report', () => {
  const row = (
    n: number,
    name: string,
    unit: { code: string; decimals: number },
    numbers: [string, string, string, string, string, string],
    options: string[] = [],
  ): StockMovementRow => ({
    variantId: id(n),
    productId: id(100 + n),
    productCode: `P-${String(n)}`,
    productName: name,
    optionValues: options,
    sku: `SKU-${String(n)}`,
    baseUnitId: id(200 + n),
    baseUnit: unit,
    opening: numbers[0],
    purchased: numbers[1],
    sold: numbers[2],
    transfers: numbers[3],
    adjusted: numbers[4],
    closing: numbers[5],
    openingValue: '1500.0000',
    closingValue: '1250.0000',
  });
  const data: StockMovementReport = {
    items: [
      row(
        1,
        'Napa 500mg',
        { code: 'pcs', decimals: 0 },
        ['1200.0000', '500.0000', '440.0000', '-10.0000', '0.0000', '1250.0000'],
        ['Strip'],
      ),
      row(2, 'Gauze roll', { code: 'm', decimals: 2 }, [
        '12.5000',
        '0.0000',
        '2.7400',
        '0.0000',
        '-0.5000',
        '9.2600',
      ]),
    ],
    nextCursor: null,
    withValue: true,
    totals: { variants: 2, openingValue: '3000.0000', closingValue: '2500.0000' },
  };
  const query = {
    from: '2026-10-01',
    to: '2026-10-31',
    show: 'all',
    sort: 'name',
  } as const;

  it('writes each quantity with its own unit, and adds up only the values', () => {
    const doc = buildDocument(
      { report: 'stock_movement', query, data },
      { ...context, warehouseName: 'Agrabad depot', categoryName: 'Medicines' },
    );
    expect(doc.landscape).toBe(true);
    expect(doc.columns).toHaveLength(10);
    expect(doc.rows.map((item) => item.cells.map(read))).toEqual([
      [
        'Napa 500mg (Strip)',
        'SKU-1',
        '1,200 pcs',
        '500 pcs',
        '440 pcs',
        '-10 pcs',
        '0 pcs',
        '1,250 pcs',
        '1500.0000',
        '1250.0000',
      ],
      [
        'Gauze roll',
        'SKU-2',
        '12.50 m',
        '0.00 m',
        '2.74 m',
        '0.00 m',
        '-0.50 m',
        '9.26 m',
        '1500.0000',
        '1250.0000',
      ],
      // Pieces and metres never add up: the total row has the values only
      ['Total', '', '', '', '', '', '', '', '3000.0000', '2500.0000'],
    ]);
    expect(doc.lines.slice(0, 4)).toEqual([
      '1 Oct 2026 – 31 Oct 2026',
      'Warehouse: Agrabad depot',
      'Category: Medicines',
      'Also the products that did not move',
    ]);
    expect(fileStem({ report: 'stock_movement', query, data })).toBe(
      'stock-movement-2026-10-01-to-2026-10-31',
    );
  });

  it('has no value columns and no total row for someone who may not see the value', () => {
    const doc = buildDocument(
      {
        report: 'stock_movement',
        query: { ...query, show: 'moved' },
        data: {
          ...data,
          withValue: false,
          items: data.items.map((item) => ({ ...item, openingValue: null, closingValue: null })),
          totals: { variants: 2, openingValue: null, closingValue: null },
        },
      },
      context,
    );
    expect(doc.columns.map((column) => column.header)).toEqual([
      'Product',
      'SKU',
      'Opening',
      'Purchased',
      'Sold',
      'Transfers',
      'Adjusted',
      'Closing',
    ]);
    expect(doc.rows).toHaveLength(2);
    expect(doc.lines[1]).toBe('Amounts in BDT');
  });
});
