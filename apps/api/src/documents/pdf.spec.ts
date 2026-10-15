import { describe, expect, it } from 'vitest';

import { DOCUMENT_COPY } from './copy.js';
import type { DocumentModel } from './model.js';
import { writeDocumentPdf } from './pdf.js';

// A hand-written invoice of `count` lines in one language, the shape models.service.ts writes
function invoiceModel(language: 'en' | 'bn', count: number): DocumentModel {
  const copy = DOCUMENT_COPY[language];
  return {
    language,
    title: copy.titles.invoice,
    number: 'INV-2026-27-0042',
    fileName: 'INV-2026-27-0042.pdf',
    company: {
      name: 'Rahman Pharmaceuticals Ltd.',
      lines: ['House 12, Road 7, Dhanmondi', 'Dhaka 1205', copy.bin('0001234560101')],
      logo: null,
    },
    meta: [
      { label: copy.number, value: 'INV-2026-27-0042' },
      { label: copy.date, value: language === 'bn' ? '২৩ সেপ, ২০২৬' : '23 Sep 2026' },
    ],
    party: { label: copy.billTo, name: 'Lazz Pharma, Kalabagan', code: 'C-00042', lines: [] },
    facts: [],
    table: {
      columns: [
        { label: copy.columns.number, align: 'left', width: 0.45 },
        { label: copy.columns.item, align: 'left', width: 4.2 },
        { label: copy.columns.quantity, align: 'right', width: 1.3 },
        { label: copy.columns.amount, align: 'right', width: 1.5 },
      ],
      rows: Array.from({ length: count }, (_, index) => ({
        cells: [
          String(index + 1),
          'Napa Extra 500 mg tablet, strip of 10',
          '1,200 pcs',
          '৳14,250.00',
        ],
        details: ['SKU-NAPA-500', copy.batch('L2309')],
      })),
    },
    totals: {
      note: copy.pricesWithVat,
      rows: [{ label: copy.total, value: '৳18,42,600.00', strong: true }],
    },
    words: copy.inWords('Eighteen lakh forty-two thousand six hundred taka only'),
    note: null,
    signatures: [copy.signatures.customer, copy.signatures.authorised],
    page: copy.page('{page}', '{pages}'),
  };
}

// pdfkit compresses the page contents, but not the objects that list the pages and the fonts
function pdfText(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

function pagesOf(bytes: Uint8Array): number {
  return pdfText(bytes).match(/\/Type \/Page\b/g)?.length ?? 0;
}

describe('writeDocumentPdf', () => {
  it('fits a short invoice on one page', async () => {
    const bytes = await writeDocumentPdf(invoiceModel('en', 3), null);
    expect(pdfText(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(pagesOf(bytes)).toBe(1);
  });

  it('runs a long invoice over more pages instead of off the paper', async () => {
    // Each line with its two detail lines is about 40 pt high: 40 lines need three A4 pages
    expect(pagesOf(await writeDocumentPdf(invoiceModel('en', 40), null))).toBe(3);
  });

  it('draws Bangla with Hind Siliguri, and never with Noto Sans Bengali', async () => {
    const text = pdfText(await writeDocumentPdf(invoiceModel('bn', 3), null));
    // Embedded fonts are subsets: "ABCDEF+HindSiliguri-Regular"
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+HindSiliguri/);
    expect(text).not.toContain('NotoSansBengali');
  });

  it('leaves out a logo it cannot read, rather than failing the invoice', async () => {
    const model = invoiceModel('en', 1);
    const withLogo = {
      ...model,
      company: { ...model.company, logo: { key: 'tenants/x/logo.png', contentType: 'image/png' } },
    };
    const broken = new TextEncoder().encode('not a picture at all');
    expect(pagesOf(await writeDocumentPdf(withLogo, broken))).toBe(1);
  });

  it('draws a receipt that has no table, no totals and no note', async () => {
    const model = { ...invoiceModel('en', 0), table: null, totals: null, words: null };
    expect(pagesOf(await writeDocumentPdf(model, null))).toBe(1);
  });
});
