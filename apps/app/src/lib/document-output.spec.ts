import type { DocumentFile, DocumentShare } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  languageName,
  otherLanguage,
  recipientRole,
  shareState,
  waitForPdf,
} from './document-output';

function file(status: DocumentFile['status']): DocumentFile {
  return {
    id: '0199a6c0-0000-7000-8000-000000000001',
    language: 'en',
    status,
    fileName: status === 'ready' ? 'INV-2026-27-0042.pdf' : null,
    sizeBytes: status === 'ready' ? 48_213 : null,
    download:
      status === 'ready'
        ? { url: 'https://files.example.com/x.pdf', expiresAt: '2026-10-14T10:05:00.000Z' }
        : null,
    createdAt: '2026-10-14T10:00:00.000Z',
    finishedAt: status === 'pending' ? null : '2026-10-14T10:00:02.000Z',
  };
}

const noWait = () => Promise.resolve();

describe('waitForPdf', () => {
  it('does not ask again for a file that is ready', async () => {
    let polls = 0;
    const outcome = await waitForPdf(
      file('ready'),
      () => {
        polls += 1;
        return Promise.resolve(file('ready'));
      },
      { sleep: noWait },
    );
    expect(outcome.status).toBe('ready');
    expect(polls).toBe(0);
  });

  it('asks until the worker is done', async () => {
    const answers = [file('pending'), file('pending'), file('ready')];
    let polls = 0;
    const outcome = await waitForPdf(
      file('pending'),
      () => Promise.resolve(answers[polls++] ?? file('ready')),
      { sleep: noWait },
    );
    expect(outcome).toMatchObject({ status: 'ready', file: { fileName: 'INV-2026-27-0042.pdf' } });
    expect(polls).toBe(3);
  });

  it('says failed when the worker gave up', async () => {
    const outcome = await waitForPdf(file('pending'), () => Promise.resolve(file('failed')), {
      sleep: noWait,
    });
    expect(outcome.status).toBe('failed');
  });

  it('stops waiting after the last attempt', async () => {
    let polls = 0;
    const outcome = await waitForPdf(
      file('pending'),
      () => {
        polls += 1;
        return Promise.resolve(file('pending'));
      },
      { sleep: noWait, attempts: 4 },
    );
    expect(outcome.status).toBe('slow');
    expect(polls).toBe(4);
  });
});

describe('shareState', () => {
  const share: DocumentShare = {
    id: '0199a6c0-0000-7000-8000-000000000002',
    language: 'bn',
    createdBy: { id: '0199a6c0-0000-7000-8000-000000000003', name: 'Nusrat Jahan' },
    createdAt: '2026-10-01T09:00:00.000Z',
    expiresAt: '2026-10-31T09:00:00.000Z',
    revokedAt: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
  };

  it('is active until it expires', () => {
    expect(shareState(share, new Date('2026-10-31T08:59:59.000Z'))).toBe('active');
    expect(shareState(share, new Date('2026-10-31T09:00:00.000Z'))).toBe('ended');
  });

  it('says turned off before ended', () => {
    const revoked = { ...share, revokedAt: '2026-10-02T09:00:00.000Z' };
    expect(shareState(revoked, new Date('2026-11-30T00:00:00.000Z'))).toBe('revoked');
  });
});

describe('languages', () => {
  it('names the other language by its own name', () => {
    expect(otherLanguage('en')).toBe('bn');
    expect(otherLanguage('bn')).toBe('en');
    expect(languageName('bn')).toBe('বাংলা');
  });
});

// Step 17b: the Send menu reads the recipient's language and phone from the right side
describe('recipientRole', () => {
  it('sends a purchase order to its supplier and every sales document to its customer', () => {
    expect(recipientRole('purchase_order')).toBe('supplier');
    expect(recipientRole('invoice')).toBe('customer');
  });
});
