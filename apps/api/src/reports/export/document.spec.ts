import type { BalanceSheet, ReportSection, TrialBalance } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { buildDocument, type DocCell, type DocumentContext, fileStem } from './document.js';

const context: DocumentContext = {
  language: 'en',
  company: 'Rahman Garments Ltd.',
  currency: 'BDT',
  timeZone: 'Asia/Dhaka',
  branchName: null,
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
