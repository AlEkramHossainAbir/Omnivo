import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  attachmentSchema,
  auditPageSchema,
  meResponseSchema,
  problemSchema,
  type Settings,
  settingsSchema,
  uploadTicketSchema,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  startStorage,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let app: NestFastifyApplication;
let owner: SignedIn;
let viewer: SignedIn;

beforeAll(async () => {
  [pg, redis, storage] = await Promise.all([startPostgres(), startRedis(), startStorage()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'nasrin@rahmangarments.com',
    workspace: 'rahman-garments',
  });
  viewer = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), storage.container.stop()]);
});

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, as = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function current(): Promise<Settings> {
  return settingsSchema.parse((await send('GET', '/settings')).json());
}

function form(settings: Settings) {
  return {
    version: settings.version,
    companyName: settings.companyName,
    legalName: settings.legalName ?? '',
    bin: settings.bin ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    address: settings.address ?? '',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
    allowNegativeStock: settings.allowNegativeStock,
  };
}

describe('settings', () => {
  it('starts with Bangladesh defaults', async () => {
    expect(await current()).toMatchObject({
      companyName: 'Rahman Garments Ltd.',
      baseCurrency: 'BDT',
      fiscalYearStartMonth: 7,
      timezone: 'Asia/Dhaka',
      logo: null,
      version: 1,
    });
  });

  it('saves the company profile, renames the workspace and audits only what changed', async () => {
    const res = await send('PUT', '/settings', {
      ...form(await current()),
      companyName: 'Rahman Knit Garments Ltd.',
      bin: '000123456-0101',
    });
    expect(res.statusCode).toBe(200);
    expect(settingsSchema.parse(res.json())).toMatchObject({ bin: '0001234560101', version: 2 });

    // switcher আর লগইন যা পড়ে (tenants.name) সেটাও বদলেছে
    const me = await send('GET', '/auth/me');
    expect(meResponseSchema.parse(me.json()).tenant.name).toBe('Rahman Knit Garments Ltd.');

    const audit = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace')).json(),
    );
    const entry = audit.items.find((item) => item.action === 'settings.updated');
    expect(entry?.changes).toEqual({
      companyName: { from: 'Rahman Garments Ltd.', to: 'Rahman Knit Garments Ltd.' },
      bin: { from: null, to: '0001234560101' },
    });
    // audit-এর request id আর response header-এর id একই — সাপোর্টে লগ মেলানোর সূত্র
    expect(entry?.requestId).toBe(res.headers['x-request-id']);
  });

  it('refuses a save based on an old version', async () => {
    const res = await send('PUT', '/settings', { ...form(await current()), version: 1 });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('version_conflict');
  });

  it('checks the BIN and the time zone on the server too', async () => {
    const res = await send('PUT', '/settings', {
      ...form(await current()),
      bin: '12345',
      timezone: 'Asia/Gazipur',
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      bin: ['bin_format'],
      timezone: ['timezone_invalid'],
    });
  });

  it('lets any member read the settings but only managers change them', async () => {
    expect((await send('GET', '/settings', undefined, viewer)).statusCode).toBe(200);
    const res = await send('PUT', '/settings', form(await current()), viewer);
    expect(res.statusCode).toBe(403);
  });
});

// ১×১ px PNG — আসল ছবির বাইট, যাতে storage-এর Content-Type আর আকার সত্যিই মেলানো যায়
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function ticket(sizeBytes = PNG.length) {
  const res = await send('POST', '/attachments', {
    purpose: 'company_logo',
    fileName: 'rahman-logo.png',
    contentType: 'image/png',
    sizeBytes,
  });
  expect(res.statusCode).toBe(201);
  return uploadTicketSchema.parse(res.json());
}

describe('company logo', () => {
  it('uploads straight to storage, confirms it and shows it in the settings', async () => {
    const { attachment, upload } = await ticket();
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: PNG });
    expect(put.status).toBe(200);

    const done = await send('POST', `/attachments/${attachment.id}/complete`);
    expect(attachmentSchema.parse(done.json()).status).toBe('ready');

    const settings = settingsSchema.parse(
      (await send('PUT', '/settings/logo', { attachmentId: attachment.id })).json(),
    );
    // লোগো বদলানো version বাড়ায় না — খোলা ফর্ম এতে অচল হয় না
    expect(settings.version).toBe(2);
    if (!settings.logo) throw new Error('logo missing');
    const image = await fetch(settings.logo.url);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);

    // একই ঘণ্টায় আবার পড়লে একই ঠিকানা — ব্রাউজারের cache কাজে লাগে
    expect((await current()).logo?.url).toBe(settings.logo.url);
  });

  it('rejects an upload sent with a different Content-Type than the one signed', async () => {
    const { upload } = await ticket();
    const put = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: PNG,
    });
    expect(put.status).toBe(403);
  });

  it('refuses to confirm a file bigger than declared, and deletes it', async () => {
    const { attachment, upload } = await ticket(10);
    await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: PNG });
    const res = await send('POST', `/attachments/${attachment.id}/complete`);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('upload_incomplete');
    // মুছে ফেলা হয়েছে: আবার confirm করলে "ফাইল নেই"
    expect((await send('POST', `/attachments/${attachment.id}/complete`)).statusCode).toBe(409);
  });

  it('will not use a file that was never uploaded as the logo', async () => {
    const { attachment } = await ticket();
    const res = await send('PUT', '/settings/logo', { attachmentId: attachment.id });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('attachment_not_ready');
  });

  it('refuses an SVG before any URL is signed', async () => {
    const res = await send('POST', '/attachments', {
      purpose: 'company_logo',
      fileName: 'logo.svg',
      contentType: 'image/svg+xml',
      sizeBytes: 900,
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      contentType: ['file_type_not_allowed'],
    });
  });
});
