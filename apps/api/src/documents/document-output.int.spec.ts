import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  createdShareSchema,
  type CreditNote,
  creditNoteSchema,
  type Customer,
  customerSchema,
  type DocumentFile,
  documentEmailDraftSchema,
  documentEmailListSchema,
  documentEmailSchema,
  documentFileSchema,
  documentShareListSchema,
  type DocumentShare,
  type Invoice,
  invoiceSchema,
  type LanguageCode,
  memberPageSchema,
  notificationPageSchema,
  type OutputDocument,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  publicDocumentSchema,
  type Quotation,
  quotationSchema,
  type Receipt,
  receiptSchema,
  roleSchema,
  settingsSchema,
  setupSchema,
  stockCardSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  startStorage,
  type TestMail,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { attachmentOf, lastMailTo } from '../testing/mailpit.js';
import { joinWithoutRoles } from '../testing/workspace.js';
import { type DocumentModel, documentModelSchema } from './model.js';
import { hashShareToken } from './share-token.js';

// Step 16: a distributor's invoice, quotation, money receipt and credit note go out as PDFs, by
// email and by a WhatsApp link. The real API, the real worker, a real MinIO for the files and a
// real Mailpit for the emails. Bhairab Bazar Traders reads its documents in Bangla. Each test
// builds on the ones before it: read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// A member with no role: reads every document, sends none
let viewer: SignedIn;
// A billing clerk: may send invoices, not quotations
let clerk: SignedIn;
let units: Unit[];
let accounts: Account[];
let rates: TaxRate[];
let main: Warehouse;
let juice: Product;
let napa: Product;
let carriage: Product;
let bhairab: Customer;
// Posted: juice, Napa from a batch, and the delivery charge
let invoice: Invoice;
let draftInvoice: Invoice;
let quotation: Quotation;
let receipt: Receipt;
let creditNote: CreditNote;
// The first PDF of the invoice, in English, before anything was paid
let firstFile: DocumentFile;

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as: SignedIn | null = owner,
) {
  return app.inject({
    method,
    url,
    ...(as && { headers: bearer(as.accessToken) }),
    ...(payload && { payload }),
  });
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function unitId(code: string): string {
  const found = units.find((unit) => unit.code === code);
  if (!found) throw new Error(`no unit ${code}`);
  return found.id;
}

function rateId(name: string): string {
  const found = rates.find((rate) => rate.name === name);
  if (!found) throw new Error(`no VAT rate ${name}`);
  return found.id;
}

function account(code: string): string {
  const found = accounts.find((item) => item.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

async function addProduct(name: string, extra: Partial<ProductFormValues> = {}) {
  const res = await send('POST', '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: unitId('pcs'),
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
    ...extra,
  } satisfies ProductFormValues);
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

// Opening stock by the piece, at a cost
function openingLine(product: Product, quantity: string, unitCost: string, extra: object = {}) {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost,
    ...extra,
  };
}

// A sales line by the piece, at 15% VAT, no discount
function salesLine(product: Product, quantity: string, unitPrice: string, extra: object = {}) {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: rateId('VAT 15%'),
    ...extra,
  };
}

function invoiceLine(product: Product, quantity: string, unitPrice: string, extra: object = {}) {
  return {
    ...salesLine(product, quantity, unitPrice),
    deliveryLineId: '',
    orderLineId: '',
    batchId: '',
    serialNumbers: [],
    ...extra,
  };
}

async function invoiced(lines: object[], post: boolean): Promise<Invoice> {
  const res = await send('POST', '/invoices', {
    customerId: bhairab.id,
    date: '2026-10-06',
    dueDate: '',
    customerReference: '',
    branchId: main.branchId,
    warehouseId: main.id,
    note: '',
    lines,
    post,
  });
  expect(res.statusCode, res.body).toBe(201);
  return invoiceSchema.parse(res.json());
}

async function received(amount: string, applied: string): Promise<Receipt> {
  const res = await send('POST', '/receipts', {
    customerId: bhairab.id,
    date: '2026-10-07',
    amount,
    accountId: account('1110'),
    method: 'cash',
    reference: '',
    branchId: main.branchId,
    note: '',
    allocations: applied === '' ? [] : [{ invoiceId: invoice.id, amount: applied }],
  });
  expect(res.statusCode, res.body).toBe(201);
  return receiptSchema.parse(res.json());
}

async function credited(post: boolean): Promise<CreditNote> {
  const [line] = invoice.lines;
  if (!line) throw new Error('the invoice has no lines');
  const res = await send('POST', '/credit-notes', {
    invoiceId: invoice.id,
    date: '2026-10-08',
    reason: 'price_adjustment',
    note: '',
    lines: [
      {
        invoiceLineId: line.id,
        returnLineId: '',
        unitId: unitId('pcs'),
        quantity: '24',
        description: '',
        unitPrice: '1',
        discountType: 'percent',
        discount: '',
      },
    ],
    post,
  });
  expect(res.statusCode, res.body).toBe(201);
  return creditNoteSchema.parse(res.json());
}

async function quoted(): Promise<Quotation> {
  const res = await send('POST', '/quotations', {
    customerId: bhairab.id,
    date: '2026-10-01',
    validUntil: '2026-10-15',
    note: '',
    lines: [salesLine(juice, '240', '24')],
  });
  expect(res.statusCode, res.body).toBe(201);
  return quotationSchema.parse(res.json());
}

function documentPath(kind: OutputDocument, id: string): string {
  return `/documents/${kind}/${id}`;
}

async function fileOf(
  kind: OutputDocument,
  id: string,
  language: LanguageCode,
  as = owner,
): Promise<DocumentFile> {
  const res = await send('POST', `${documentPath(kind, id)}/files`, { language }, as);
  expect(res.statusCode, res.body).toBe(200);
  return documentFileSchema.parse(res.json());
}

// Waits for the worker: the file as the page reads it while it polls
async function finished(kind: OutputDocument, id: string, fileId: string): Promise<DocumentFile> {
  return eventually(async () => {
    const res = await send('GET', `${documentPath(kind, id)}/files/${fileId}`);
    const file = documentFileSchema.parse(res.json());
    expect(file.status).not.toBe('pending');
    return file;
  }, 8_000);
}

async function downloaded(file: DocumentFile) {
  if (file.download === null) throw new Error(`file ${file.id} has no download link`);
  const res = await fetch(file.download.url);
  expect(res.status).toBe(200);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// The page as the API wrote it on the row: what the worker draws
async function modelOf(fileId: string): Promise<DocumentModel> {
  const [row] = await superuserSql(
    (sql) => sql<{ model: unknown }[]>`SELECT model FROM document_files WHERE id = ${fileId}`,
  );
  return documentModelSchema.parse(row?.model);
}

async function jobsFor(fileId: string): Promise<number> {
  const [row] = await superuserSql(
    (sql) => sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM outbox_events
       WHERE type = 'document.file_requested' AND payload->>'fileId' = ${fileId}`,
  );
  return row?.count ?? 0;
}

async function sharesOf(kind: OutputDocument, id: string): Promise<DocumentShare[]> {
  return documentShareListSchema.parse(
    (await send('GET', `${documentPath(kind, id)}/shares`)).json(),
  ).items;
}

async function shared(kind: OutputDocument, id: string, language: LanguageCode) {
  const res = await send('POST', `${documentPath(kind, id)}/shares`, { language });
  expect(res.statusCode, res.body).toBe(201);
  expect(res.headers['cache-control']).toBe('no-store');
  return createdShareSchema.parse(res.json());
}

function tokenOf(url: string): string {
  const token = /\/d\/([\w-]{22})$/.exec(url)?.[1];
  if (!token) throw new Error(`no token in ${url}`);
  return token;
}

function opened(token: string) {
  return send('GET', `/public/documents/${token}`, undefined, null);
}

// The same worker, with the mail server or the storage switched off (or back on)
async function restartWorker(down: { mail?: boolean; storage?: boolean } = {}): Promise<void> {
  await worker.close();
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      ...(down.mail !== true && { mailUrl: mail.smtpUrl }),
      ...(down.storage !== true && { storageUrl: storage.url }),
    }),
  );
}

// A user who signs up for a workspace of their own, then joins this one; with a role, if given
async function member(
  email: string,
  fullName: string,
  password: string,
  permissions: PermissionKey[] | null,
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Store`,
    workspaceSlug: email.split('@')[0] ?? 'store',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'meghna-distributors' });
  if (permissions !== null) {
    const made = await send('POST', '/roles', { name: 'Billing', description: '' });
    expect(made.statusCode, made.body).toBe(201);
    const role = roleSchema.parse(made.json());
    const matrix = await send('PUT', '/permission-matrix', {
      roles: [{ id: role.id, version: role.version, permissions }],
    });
    expect(matrix.statusCode, matrix.body).toBe(200);
    const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
    const found = items.find((item) => item.email === email);
    if (!found) throw new Error(`${email} is not a member`);
    const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: [role.id],
      version: found.version,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
  }
  return logIn(app, { workspace: 'meghna-distributors', email, password, keepSignedIn: false });
}

beforeAll(async () => {
  [pg, redis, storage, mail] = await Promise.all([
    startPostgres(),
    startRedis(),
    startStorage(),
    startMail(),
  ]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
      storageUrl: storage.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Meghna Distributors',
    workspaceSlug: 'meghna-distributors',
    fullName: 'Shafiq Ahmed',
    email: 'shafiq@meghnadistributors.com',
    password: 'Narsingdi-depot-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const [first] = warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items;
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;

  // The header of every PDF, and the address customers' replies go to
  const settings = settingsSchema.parse((await send('GET', '/settings')).json());
  const saved = await send('PUT', '/settings', {
    version: settings.version,
    companyName: settings.companyName,
    legalName: 'Meghna Distributors Ltd.',
    bin: '000123456-0101',
    phone: '01711-000000',
    email: 'accounts@meghnadistributors.com',
    address: 'House 12, Road 4\nNarsingdi Sadar, Narsingdi',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
    allowNegativeStock: settings.allowNegativeStock,
    pricesIncludeVat: false,
  });
  expect(saved.statusCode, saved.body).toBe(200);

  juice = await addProduct('Mango juice 250 ml');
  napa = await addProduct('Napa 500 mg', {
    tracking: 'batch',
    hasExpiry: true,
    taxRateId: rateId('Exempt'),
  });
  carriage = await addProduct('Delivery charge', { type: 'service' });
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      openingLine(juice, '240', '18'),
      openingLine(napa, '120', '0.80', { lotNumber: 'NP24090', expiresOn: '2027-01-31' }),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
  const card = stockCardSchema.parse(
    (await send('GET', `/stock/variants/${variantOf(napa)}`)).json(),
  );
  const batch = card.batches.find((item) => item.lotNumber === 'NP24090');
  if (!batch) throw new Error('no Napa batch');

  const customer = await send('POST', '/customers', {
    code: '',
    name: 'Bhairab Bazar Traders',
    groupId: '',
    contactPerson: 'Rafiqul Islam',
    phone: '01712-334455',
    email: 'orders@bhairabbazar.com',
    documentLanguage: 'bn',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [
      {
        id: null,
        kind: 'billing',
        label: 'Head office',
        address: 'Station Road, Bhairab',
        phone: '',
      },
    ],
  });
  expect(customer.statusCode, customer.body).toBe(201);
  bhairab = customerSchema.parse(customer.json());

  invoice = await invoiced(
    [
      invoiceLine(juice, '24', '25'),
      invoiceLine(napa, '50', '1.2', { taxRateId: rateId('Exempt'), batchId: batch.batchId }),
      invoiceLine(carriage, '1', '500'),
    ],
    true,
  );
  draftInvoice = await invoiced([invoiceLine(carriage, '1', '300')], false);
  quotation = await quoted();

  viewer = await member('rina@meghnadistributors.com', 'Rina Akter', 'Counter-cash-2026', null);
  clerk = await member('tanvir@meghnadistributors.com', 'Tanvir Hasan', 'Billing-desk-2026', [
    'sales.invoice.manage',
  ]);
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([
    pg.container.stop(),
    redis.container.stop(),
    storage.container.stop(),
    mail.container.stop(),
  ]);
});

describe('the PDF of a document', () => {
  it('is drawn once per look, in the background, and downloaded by its link', async () => {
    firstFile = await fileOf('invoice', invoice.id, 'en');
    expect(firstFile).toMatchObject({ status: 'pending', download: null, language: 'en' });
    // A second click while it is drawn: the same row, and still one job
    const again = await fileOf('invoice', invoice.id, 'en');
    expect(again.id).toBe(firstFile.id);
    expect(await jobsFor(firstFile.id)).toBe(1);

    const ready = await finished('invoice', invoice.id, firstFile.id);
    expect(ready).toMatchObject({ status: 'ready', fileName: `${invoice.number ?? ''}.pdf` });
    const { res, bytes } = await downloaded(ready);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain(`${invoice.number ?? ''}.pdf`);
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.byteLength).toBe(ready.sizeBytes);
    firstFile = ready;

    // Asked again once it is ready: the same file at once, with no new job
    const later = await fileOf('invoice', invoice.id, 'en');
    expect([later.id, later.status]).toEqual([firstFile.id, 'ready']);
    expect(await jobsFor(firstFile.id)).toBe(1);
  });

  it('writes the page as text: every line, the totals and the amount in words', async () => {
    const model = await modelOf(firstFile.id);
    expect(model).toMatchObject({
      language: 'en',
      title: 'Invoice',
      number: invoice.number,
      company: {
        name: 'Meghna Distributors Ltd.',
        lines: [
          'House 12, Road 4',
          'Narsingdi Sadar, Narsingdi',
          // Stored as digits only, as the NBR writes it
          'BIN 0001234560101',
          'Phone 01711-000000',
        ],
        logo: null,
      },
      party: {
        label: 'Bill to',
        name: 'Bhairab Bazar Traders',
        lines: ['Head office', 'Station Road, Bhairab'],
      },
      words: 'In words: One thousand three hundred twenty-five taka only',
      signatures: ['Customer’s signature', 'Authorised signature'],
    });
    expect(model.meta.slice(0, 3)).toEqual([
      { label: 'No.', value: invoice.number },
      { label: 'Date', value: '6 Oct 2026' },
      { label: 'Due date', value: '5 Nov 2026' },
    ]);
    expect(model.table?.rows.map((row) => row.cells)).toEqual([
      ['1', 'Mango juice 250 ml', '24 pcs', '৳25.00', '—', 'VAT 15%', '৳600.00'],
      ['2', 'Napa 500 mg', '50 pcs', '৳1.20', '—', 'Exempt', '৳60.00'],
      ['3', 'Delivery charge', '1 pcs', '৳500.00', '—', 'VAT 15%', '৳500.00'],
    ]);
    // Under the item: its SKU, the batch and expiry a pharmacy needs, and the challan the goods
    // left on. A direct invoice makes its own challan; the delivery charge, a service, has none.
    expect(model.table?.rows.map((row) => row.details)).toEqual([
      ['P-00001', 'From DC-2026-27-0001'],
      ['P-00002', 'Batch NP24090, expires 31 Jan 2027', 'From DC-2026-27-0001'],
      ['P-00003'],
    ]);
    // Nothing paid yet: no "Paid" or "Still due" rows
    expect(model.totals?.rows).toEqual([
      { label: 'Before VAT', value: '৳1,160.00', strong: false },
      { label: 'VAT', value: '৳165.00', strong: false },
      { label: 'Total', value: '৳1,325.00', strong: true },
    ]);
  });

  it('is written in the language asked for, a new file for each', async () => {
    const bangla = await fileOf('invoice', invoice.id, 'bn');
    expect(bangla.id).not.toBe(firstFile.id);
    const model = await modelOf(bangla.id);
    expect(model).toMatchObject({
      language: 'bn',
      title: 'ইনভয়েস',
      words: 'কথায়: এক হাজার তিনশত পঁচিশ টাকা মাত্র',
    });
    expect(model.totals?.rows.at(-1)).toEqual({ label: 'মোট', value: '৳১,৩২৫.০০', strong: true });
    expect(model.meta[1]).toEqual({ label: 'তারিখ', value: '৬ অক্টো, ২০২৬' });
    expect((await finished('invoice', invoice.id, bangla.id)).status).toBe('ready');
  });

  it('is a new file once the invoice is paid, with what is still due', async () => {
    receipt = await received('500', '500');
    const paid = await fileOf('invoice', invoice.id, 'en');
    expect(paid.id).not.toBe(firstFile.id);
    expect((await modelOf(paid.id)).totals?.rows.slice(-2)).toEqual([
      { label: 'Paid', value: '৳500.00', strong: false },
      { label: 'Still due', value: '৳825.00', strong: true },
    ]);
    // The first file stays as it was drawn: a ready file never changes
    const old = await finished('invoice', invoice.id, firstFile.id);
    expect([old.status, old.sizeBytes, old.finishedAt]).toEqual([
      'ready',
      firstFile.sizeBytes,
      firstFile.finishedAt,
    ]);
  });

  it('is drawn for all four documents, each with its own words', async () => {
    creditNote = await credited(true);
    const asked = await Promise.all(
      (
        [
          ['quotation', quotation.id],
          ['receipt', receipt.id],
          ['credit_note', creditNote.id],
        ] as const
      ).map(async ([kind, id]) => ({ kind, id, file: await fileOf(kind, id, 'en') })),
    );
    const [ofQuotation, ofReceipt, ofCreditNote] = await Promise.all(
      asked.map(({ file }) => modelOf(file.id)),
    );
    // A quotation is an offer: no amount in words
    expect(ofQuotation).toMatchObject({ title: 'Quotation', words: null });
    expect(ofQuotation?.meta.at(-1)).toEqual({ label: 'Valid until', value: '15 Oct 2026' });
    expect(ofReceipt).toMatchObject({
      title: 'Money receipt',
      words: 'In words: Five hundred taka only',
      facts: [
        { label: 'Amount received', value: '৳500.00' },
        { label: 'Paid by', value: 'Cash' },
      ],
      // All of it was applied: no advance row
      totals: null,
    });
    expect(ofReceipt?.table?.rows[0]?.cells).toEqual([
      invoice.number,
      '6 Oct 2026',
      '৳1,325.00',
      '৳500.00',
    ]);
    expect(ofCreditNote).toMatchObject({ title: 'Credit note' });
    expect(ofCreditNote?.meta.slice(2)).toEqual([
      { label: 'Original invoice', value: invoice.number },
      { label: 'Invoice date', value: '6 Oct 2026' },
      { label: 'Reason', value: 'Price cut' },
    ]);
    for (const { kind, id, file } of asked) {
      const ready = await finished(kind, id, file.id);
      expect(isPdf((await downloaded(ready)).bytes)).toBe(true);
    }
  }, 20_000);

  it('goes out only for a numbered document', async () => {
    const draftNote = await credited(false);
    const voided = await received('100', '');
    const voidRes = await send('POST', `/receipts/${voided.id}/void`, {
      version: voided.version,
      date: '2026-10-08',
      reason: 'Counted twice',
    });
    expect(voidRes.statusCode, voidRes.body).toBe(200);
    for (const [kind, id] of [
      ['invoice', draftInvoice.id],
      ['credit_note', draftNote.id],
      ['receipt', voided.id],
    ] as const) {
      const res = await send('POST', `${documentPath(kind, id)}/files`, { language: 'en' });
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).code).toBe('document_not_issued');
    }
    // An id that is no invoice, and a kind that is no document
    const missing = await send('POST', `${documentPath('invoice', quotation.id)}/files`, {
      language: 'en',
    });
    expect(missing.statusCode).toBe(404);
    const strange = await send('POST', `/documents/sales_order/${invoice.id}/files`, {
      language: 'en',
    });
    expect(strange.statusCode).toBe(400);
  });

  it("answers 404 for a file of another document, even one of this workspace's", async () => {
    const res = await send(
      'GET',
      `${documentPath('quotation', quotation.id)}/files/${firstFile.id}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('is tried again on the same row after the worker gave up on it', async () => {
    await restartWorker({ storage: true });
    const asked = await fileOf('quotation', quotation.id, 'bn');
    expect((await finished('quotation', quotation.id, asked.id)).status).toBe('failed');

    await restartWorker();
    const retried = await fileOf('quotation', quotation.id, 'bn');
    expect([retried.id, retried.status]).toEqual([asked.id, 'pending']);
    expect(await jobsFor(asked.id)).toBe(2);
    expect((await finished('quotation', quotation.id, asked.id)).status).toBe('ready');
  }, 30_000);
});

describe('emailing a document', () => {
  it('starts the dialog with the customer, a subject and a message in the language chosen', async () => {
    const english = documentEmailDraftSchema.parse(
      (await send('GET', `${documentPath('invoice', invoice.id)}/email-draft?language=en`)).json(),
    );
    expect(english).toEqual({
      to: 'orders@bhairabbazar.com',
      subject: `Invoice ${invoice.number ?? ''} from Meghna Distributors Ltd.`,
      message:
        'Dear Bhairab Bazar Traders,\n\n' +
        `Please find attached invoice ${invoice.number ?? ''} for ৳1,325.00, due on 5 Nov 2026.\n\n` +
        'Regards,\nShafiq Ahmed\nMeghna Distributors Ltd.',
    });
    const bangla = documentEmailDraftSchema.parse(
      (await send('GET', `${documentPath('invoice', invoice.id)}/email-draft?language=bn`)).json(),
    );
    expect(bangla.subject).toBe(`Meghna Distributors Ltd. থেকে ইনভয়েস ${invoice.number ?? ''}`);
  });

  it('sends the PDF from the company, with replies going to the company', async () => {
    const res = await send('POST', `${documentPath('invoice', invoice.id)}/emails`, {
      to: 'orders@bhairabbazar.com; Rafiq@BhairabBazar.com',
      cc: 'shafiq@meghnadistributors.com',
      subject: `Invoice ${invoice.number ?? ''}`,
      message: 'Dear Rafiq bhai,\n\nThe bill for <b>last week</b>.',
      language: 'en',
    });
    expect(res.statusCode, res.body).toBe(201);
    const email = documentEmailSchema.parse(res.json());
    expect(email).toMatchObject({
      // Lower case, as the mail server compares them
      to: ['orders@bhairabbazar.com', 'rafiq@bhairabbazar.com'],
      cc: ['shafiq@meghnadistributors.com'],
      status: 'pending',
      sentBy: { name: 'Shafiq Ahmed' },
      sentAt: null,
    });

    const sent = await eventually(() => lastMailTo(mail.apiUrl, 'rafiq@bhairabbazar.com'), 8_000);
    expect(sent).toMatchObject({
      subject: `Invoice ${invoice.number ?? ''}`,
      from: { name: 'Meghna Distributors Ltd. via Omnivo' },
      cc: ['shafiq@meghnadistributors.com'],
      replyTo: ['accounts@meghnadistributors.com'],
    });
    // The message as typed, the server's lines under it, and the HTML escaped
    expect(sent.text).toContain('Dear Rafiq bhai,\n\nThe bill for <b>last week</b>.');
    expect(sent.text).toContain(`Attached: ${invoice.number ?? ''}.pdf`);
    expect(sent.text).toContain(
      'Shafiq Ahmed sent this from Meghna Distributors Ltd. using Omnivo.',
    );
    expect(sent.text).toContain('To reach Meghna Distributors Ltd., reply to this email.');
    expect(sent.html).toContain(
      'Dear Rafiq bhai,<br><br>The bill for &lt;b&gt;last week&lt;/b&gt;.',
    );
    const [attachment] = sent.attachments;
    expect(attachment).toMatchObject({
      fileName: `${invoice.number ?? ''}.pdf`,
      contentType: 'application/pdf',
    });
    expect(isPdf(await attachmentOf(mail.apiUrl, sent, attachment?.partId ?? ''))).toBe(true);

    const history = await eventually(async () => {
      const { items } = documentEmailListSchema.parse(
        (await send('GET', `${documentPath('invoice', invoice.id)}/emails`)).json(),
      );
      expect(items[0]?.status).toBe('sent');
      return items;
    });
    expect(history.map((item) => item.id)).toEqual([email.id]);
    expect(history[0]?.sentAt).not.toBeNull();
  }, 20_000);

  it('checks the boxes, each error under its own box', async () => {
    const form = {
      to: 'orders@bhairabbazar.com',
      cc: '',
      subject: 'Invoice',
      message: '',
      language: 'en',
    };
    const cases = [
      [{ to: ' ' }, { to: ['email_to_required'] }],
      [{ to: 'orders@bhairabbazar' }, { to: ['email_invalid'] }],
      [{ cc: 'a@x.com, b@x.com, c@x.com, d@x.com, e@x.com, f@x.com' }, { cc: ['email_too_many'] }],
      [{ subject: '  ' }, { subject: ['email_subject_required'] }],
    ] as const;
    for (const [change, errors] of cases) {
      const res = await send('POST', `${documentPath('invoice', invoice.id)}/emails`, {
        ...form,
        ...change,
      });
      expect(res.statusCode).toBe(400);
      expect(problemOf(res).fieldErrors).toEqual(errors);
    }
  });

  it('fails when the mail server is down, and the bell tells the sender', async () => {
    await restartWorker({ mail: true });
    const res = await send(
      'POST',
      `${documentPath('invoice', invoice.id)}/emails`,
      {
        to: 'orders@bhairabbazar.com',
        cc: '',
        subject: 'Invoice',
        message: '',
        language: 'bn',
      },
      clerk,
    );
    expect(res.statusCode, res.body).toBe(201);
    const email = documentEmailSchema.parse(res.json());
    await eventually(async () => {
      const { items } = documentEmailListSchema.parse(
        (await send('GET', `${documentPath('invoice', invoice.id)}/emails`)).json(),
      );
      expect(items.find((item) => item.id === email.id)?.status).toBe('failed');
    }, 8_000);
    // The clerk pressed Send, so the clerk's bell rings, not the owner's
    const ofClerk = notificationPageSchema.parse(
      (await send('GET', '/notifications', undefined, clerk)).json(),
    );
    expect(ofClerk.items[0]).toMatchObject({
      type: 'document.email_failed',
      params: { document: 'invoice', id: invoice.id, number: invoice.number },
    });
    const ofOwner = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(ofOwner.items.map((item) => item.type)).not.toContain('document.email_failed');
    await restartWorker();
  }, 30_000);
});

describe('share links', () => {
  let token: string;

  it('are made for the customer, with a WhatsApp message to their number', async () => {
    const made = await shared('invoice', invoice.id, 'bn');
    token = tokenOf(made.url);
    expect(made.url).toBe(`http://localhost:5173/d/${token}`);
    expect(made.message).toContain(made.url);
    expect(made.message).toContain('লিংকটা ৩০ দিন কাজ করবে।');
    // 01712-334455 as WhatsApp wants it: the country code and the digits
    expect(made.whatsAppUrl).toBe(
      `https://wa.me/8801712334455?text=${encodeURIComponent(made.message)}`,
    );
    expect(made.share).toMatchObject({
      language: 'bn',
      createdBy: { name: 'Shafiq Ahmed' },
      revokedAt: null,
      firstOpenedAt: null,
    });
    // 30 days from now
    const days = (Date.parse(made.share.expiresAt) - Date.parse(made.share.createdAt)) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    // Only the hash is kept: the token itself is nowhere in the table
    const [stored] = await superuserSql(
      (sql) => sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM document_shares
         WHERE token_hash = ${token} OR position(${token} IN token_hash) > 0`,
    );
    expect(stored?.count).toBe(0);
    expect((await sharesOf('invoice', invoice.id)).map((item) => item.id)).toEqual([made.share.id]);
  });

  it('open a page without a login, with the PDF in the link’s language', async () => {
    const res = await opened(token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const page = publicDocumentSchema.parse(res.json());
    expect(page).toMatchObject({
      company: 'Meghna Distributors Ltd.',
      logoUrl: null,
      kind: 'invoice',
      number: invoice.number,
      date: '2026-10-06',
      customer: 'Bhairab Bazar Traders',
      total: invoice.total,
      currency: 'BDT',
      dueDate: '2026-11-05',
      language: 'bn',
    });
    // Paid ৳500 of ৳1,325, and the credit note took ৳27.60 off (৳24 and its VAT)
    expect(page.amountDue).toBe('797.4000');
    const ready = await eventually(async () => {
      const again = publicDocumentSchema.parse((await opened(token)).json());
      expect(again.file.status).toBe('ready');
      return again.file;
    }, 8_000);
    expect(ready.language).toBe('bn');
    expect(isPdf((await downloaded(ready)).bytes)).toBe(true);

    const [share] = await sharesOf('invoice', invoice.id);
    expect(share?.firstOpenedAt).not.toBeNull();
    expect(Date.parse(share?.lastOpenedAt ?? '')).toBeGreaterThan(
      Date.parse(share?.firstOpenedAt ?? ''),
    );
  });

  it('give one answer for an unknown, ended or turned-off link', async () => {
    // A link made 31 days ago, written past the API: the table lets no one move a link's dates
    const ended = 'Ended-link-0123456789A';
    await superuserSql(
      (sql) => sql`
        INSERT INTO document_shares (id, tenant_id, kind, document_id, language, token_hash,
                                     created_by, created_at, expires_at)
        SELECT gen_random_uuid(), tenant_id, kind, document_id, language,
               ${hashShareToken(ended)}, created_by, now() - interval '31 days',
               now() - interval '1 day'
          FROM document_shares WHERE token_hash = ${hashShareToken(token)}`,
    );
    const off = await shared('invoice', invoice.id, 'en');
    const revoked = await send(
      'POST',
      `${documentPath('invoice', invoice.id)}/shares/${off.share.id}/revoke`,
    );
    expect(revoked.statusCode).toBe(204);
    // Pressed twice: nothing more happens, and it is not an error
    const twice = await send(
      'POST',
      `${documentPath('invoice', invoice.id)}/shares/${off.share.id}/revoke`,
    );
    expect(twice.statusCode).toBe(204);

    const answers = await Promise.all(
      ['AAAAAAAAAAAAAAAAAAAAAA', ended, tokenOf(off.url)].map(opened),
    );
    for (const res of answers) {
      expect(res.statusCode).toBe(404);
      // The same body word for word, with nothing more in it; only the request's own id differs
      const problem = problemOf(res);
      expect(problem).toMatchObject({
        title: 'Not Found',
        status: 404,
        detail: 'This link does not work any more.',
        code: 'share_link_not_found',
      });
      expect(Object.keys(problem).toSorted()).toEqual([
        'code',
        'detail',
        'requestId',
        'status',
        'title',
      ]);
    }
    // A refused opening is not an opening
    const shares = await sharesOf('invoice', invoice.id);
    expect(shares.find((item) => item.id === off.share.id)?.firstOpenedAt).toBeNull();
  });

  it('stop working once the quotation is deleted or the receipt voided', async () => {
    const offer = await quoted();
    const ofOffer = await shared('quotation', offer.id, 'en');
    const money = await received('200', '');
    const ofMoney = await shared('receipt', money.id, 'en');
    expect((await opened(tokenOf(ofOffer.url))).statusCode).toBe(200);
    expect((await opened(tokenOf(ofMoney.url))).statusCode).toBe(200);

    const deleted = await send(
      'DELETE',
      `/quotations/${offer.id}?version=${String(offer.version)}`,
    );
    expect(deleted.statusCode, deleted.body).toBe(204);
    const voided = await send('POST', `/receipts/${money.id}/void`, {
      version: money.version,
      date: '2026-10-08',
      reason: 'Bounced cheque',
    });
    expect(voided.statusCode, voided.body).toBe(200);
    for (const url of [ofOffer.url, ofMoney.url]) {
      const res = await opened(tokenOf(url));
      expect(res.statusCode).toBe(404);
      expect(problemOf(res).code).toBe('share_link_not_found');
    }
  });

  it('are turned off only on their own document', async () => {
    const [share] = await sharesOf('invoice', invoice.id);
    const elsewhere = await send(
      'POST',
      `${documentPath('quotation', quotation.id)}/shares/${share?.id ?? ''}/revoke`,
    );
    expect(elsewhere.statusCode).toBe(404);
    // Still working
    expect((await opened(token)).statusCode).toBe(200);
  });
});

describe('who may send', () => {
  it('needs the manage permission of the kind, but reading needs only a login', async () => {
    const [share] = await sharesOf('invoice', invoice.id);
    const asViewer = [
      send(
        'GET',
        `${documentPath('invoice', invoice.id)}/email-draft?language=en`,
        undefined,
        viewer,
      ),
      send(
        'POST',
        `${documentPath('invoice', invoice.id)}/emails`,
        { to: 'orders@bhairabbazar.com', cc: '', subject: 'Invoice', message: '', language: 'en' },
        viewer,
      ),
      send('POST', `${documentPath('invoice', invoice.id)}/shares`, { language: 'en' }, viewer),
      send(
        'POST',
        `${documentPath('invoice', invoice.id)}/shares/${share?.id ?? ''}/revoke`,
        undefined,
        viewer,
      ),
    ];
    for (const res of await Promise.all(asViewer)) {
      expect(res.statusCode).toBe(403);
      expect(problemOf(res)).toMatchObject({
        code: 'permission_missing',
        params: { permissions: 'sales.invoice.manage' },
      });
    }
    // The clerk sends invoices, not quotations
    const offer = await send(
      'POST',
      `${documentPath('quotation', quotation.id)}/shares`,
      { language: 'en' },
      clerk,
    );
    expect(problemOf(offer).params).toEqual({ permissions: 'sales.quotation.manage' });
    expect(
      (
        await send(
          'POST',
          `${documentPath('invoice', invoice.id)}/shares`,
          { language: 'en' },
          clerk,
        )
      ).statusCode,
    ).toBe(201);

    // Downloading and the history are reading: anyone signed in
    expect((await fileOf('invoice', invoice.id, 'en', viewer)).language).toBe('en');
    for (const list of ['emails', 'shares']) {
      const res = await send(
        'GET',
        `${documentPath('invoice', invoice.id)}/${list}`,
        undefined,
        viewer,
      );
      expect(res.statusCode).toBe(200);
    }
  });
});
