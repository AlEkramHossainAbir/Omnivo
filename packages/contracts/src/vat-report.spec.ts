import { describe, expect, it } from 'vitest';

import { isVatDocumentKind, vatDocumentQuerySchema, vatReportFilterSchema } from './vat-report.js';

describe('the VAT report', () => {
  it('refuses a period that ends before it starts', () => {
    expect(
      vatReportFilterSchema.safeParse({ from: '2026-10-31', to: '2026-10-01' }).error?.issues[0]
        ?.message,
    ).toBe('report_range_invalid');
  });

  it('needs a side for its documents', () => {
    expect(vatDocumentQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(
      false,
    );
    expect(
      vatDocumentQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31', side: 'input' }).limit,
    ).toBe(50);
  });

  it('narrows a document kind it knows', () => {
    expect(isVatDocumentKind('debit_note')).toBe(true);
    expect(isVatDocumentKind('something_new')).toBe(false);
  });
});
