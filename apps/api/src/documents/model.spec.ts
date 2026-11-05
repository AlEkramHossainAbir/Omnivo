import { describe, expect, it } from 'vitest';

import { PermanentJobError } from '../common/outbox/outbox.js';
import { modelOf } from './file-maker.js';
import type { FileRow } from './files.js';
import { type DocumentModel, fingerprintOf } from './model.js';

const model: DocumentModel = {
  language: 'en',
  title: 'Money receipt',
  number: 'MR-2026-27-0007',
  fileName: 'MR-2026-27-0007.pdf',
  company: { name: 'Meghna Distributors Ltd.', lines: ['Narsingdi'], logo: null },
  meta: [{ label: 'No.', value: 'MR-2026-27-0007' }],
  party: { label: 'Received from', name: 'Bhairab Bazar Traders', code: 'C-00001', lines: [] },
  facts: [{ label: 'Amount received', value: '৳500.00' }],
  table: null,
  totals: null,
  words: 'In words: Five hundred taka only',
  note: null,
  signatures: ['Received by', 'Authorised signature'],
  page: 'Page {page} of {pages}',
};

function rowWith(stored: unknown): FileRow {
  return {
    id: '01939d1c-0000-7000-8000-000000000001',
    tenantId: '01939d1c-0000-7000-8000-000000000002',
    kind: 'receipt',
    documentId: '01939d1c-0000-7000-8000-000000000003',
    language: 'en',
    fingerprint: fingerprintOf(model),
    model: stored,
    status: 'pending',
    fileName: null,
    contentType: null,
    sizeBytes: null,
    storageKey: null,
    requestedBy: null,
    createdAt: new Date('2026-10-07T04:00:00Z'),
    finishedAt: null,
  };
}

describe('fingerprintOf', () => {
  it('is the same for the same look', () => {
    expect(fingerprintOf(structuredClone(model))).toBe(fingerprintOf(model));
    expect(fingerprintOf(model)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with any word or number on the page', () => {
    const others = [
      { ...model, words: 'In words: Five hundred taka only.' },
      { ...model, facts: [{ label: 'Amount received', value: '৳500.01' }] },
      { ...model, language: 'bn' as const },
      {
        ...model,
        company: { ...model.company, logo: { key: 'logo-2.png', contentType: 'image/png' } },
      },
    ];
    for (const other of others) expect(fingerprintOf(other)).not.toBe(fingerprintOf(model));
  });
});

describe('modelOf', () => {
  it('reads the model as the database gives it back', () => {
    // jsonb sorts the keys its own way: the model is the same, only the order differs
    const reordered: unknown = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(model).reverse())),
    );
    expect(modelOf(rowWith(reordered))).toEqual(model);
  });

  it('fails for good on a model this worker cannot read', () => {
    const older = { ...model, title: undefined, heading: 'Money receipt' };
    expect(() => modelOf(rowWith(older))).toThrow(PermanentJobError);
  });
});
