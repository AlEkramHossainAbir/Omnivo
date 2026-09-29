import { type AuthSession, type Preferences, routes, type Settings } from '@omnivo/contracts';
import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw';

import { API_URL } from '../lib/api';
import { MEMBERS, meIn, WORKSPACES, type Workspace } from './fixtures';
import { mock, problem, readBody, readQuery, reply } from './mock';
import {
  assertCodeFree,
  checkVersion,
  dataOf,
  diff,
  findBranch,
  MockProblem,
  record,
  seriesList,
} from './workspace-data';

// mock সার্ভারের অবস্থা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে
let signedIn = true;
let workspace: Workspace = WORKSPACES[0];
let preferences: Preferences = { language: null, theme: 'system' };

// আপলোড হওয়া ফাইল: storage-এর বদলে ব্রাউজারের blob URL — <img src>-এ সরাসরি বসে
const uploads = new Map<string, { contentType: string; sizeBytes: number; url?: string }>();
const MOCK_STORAGE = `${API_URL}/mock-storage`;

function current() {
  return dataOf(workspace);
}

function me() {
  return meIn(workspace, current().settings.companyName, preferences);
}

// handler-এর ভেতরে MockProblem ছুড়লেই আসল API-র মতো problem response — প্রতিটা নিয়মে আলাদা
// if/return লিখতে হয় না
function guarded(resolver: HttpResponseResolver): HttpResponseResolver {
  return async (info) => {
    try {
      return await resolver(info);
    } catch (error) {
      if (error instanceof MockProblem) return problem(error.status, error.code, error.fieldErrors);
      throw error;
    }
  };
}

// audit-এর "আগের মান" — ফর্মের ঘরগুলো
function editable(settings: Settings) {
  return {
    companyName: settings.companyName,
    legalName: settings.legalName,
    bin: settings.bin,
    phone: settings.phone,
    email: settings.email,
    address: settings.address,
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
  };
}

function session(): AuthSession {
  return {
    accessToken: `mock-${crypto.randomUUID()}`,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

// UI-র প্রতিটা পথ দেখার জন্য: লগইনে পাসওয়ার্ড "wrong-password" → invalid_credentials,
// সাইনআপে ঠিকানা "rahman-garments" → slug_taken
export const handlers = [
  mock(routes.health.check, () => reply(routes.health.check, { status: 'ok' })),

  mock(routes.auth.refresh, () =>
    signedIn ? reply(routes.auth.refresh, session()) : problem(401, 'session_ended'),
  ),

  mock(routes.auth.me, () => reply(routes.auth.me, me())),

  mock(routes.me.updatePreferences, async ({ request }) => {
    const body = await readBody(routes.me.updatePreferences.body, request);
    preferences = {
      language: body.language ?? preferences.language,
      theme: body.theme ?? preferences.theme,
    };
    return reply(routes.me.updatePreferences, preferences);
  }),

  mock(routes.auth.login, async ({ request }) => {
    const body = await readBody(routes.auth.login.body, request);
    await delay();
    if (body.password === 'wrong-password') return problem(401, 'invalid_credentials');
    signedIn = true;
    return reply(routes.auth.login, session());
  }),

  mock(routes.auth.signUp, async ({ request }) => {
    const body = await readBody(routes.auth.signUp.body, request);
    await delay();
    if (body.workspaceSlug === WORKSPACES[0].slug) {
      return problem(409, 'slug_taken', { workspaceSlug: ['slug_taken'] });
    }
    signedIn = true;
    return reply(routes.auth.signUp, session());
  }),

  mock(routes.auth.switchTenant, async ({ request }) => {
    const { tenantId } = await readBody(routes.auth.switchTenant.body, request);
    const target = WORKSPACES.find((candidate) => candidate.tenantId === tenantId);
    if (!target) return problem(403, 'switch_denied');
    workspace = target;
    return reply(routes.auth.switchTenant, session());
  }),

  mock(routes.auth.logout, () => {
    signedIn = false;
    return reply(routes.auth.logout, undefined);
  }),

  mock(routes.members.list, async ({ request }) => {
    const query = readQuery(routes.members.list.query, request);
    // আসল API keyset ব্যবহার করে; mock-এ cursor শুধু একটা offset — ক্লায়েন্টের কাছে দুটোই অস্বচ্ছ
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const sorted = MEMBERS.toSorted((a, b) => a.fullName.localeCompare(b.fullName));
    if (query.sort === '-name') sorted.reverse();
    const items = sorted.slice(start, start + query.limit);
    const end = start + items.length;
    // পাতার মাঝে একটু দেরি — "Loading more…" চোখে দেখা যায়
    await delay(400);
    return reply(routes.members.list, {
      items,
      nextCursor: end < sorted.length ? String(end) : null,
    });
  }),

  mock(routes.settings.get, () => reply(routes.settings.get, current().settings)),

  mock(
    routes.settings.update,
    guarded(async ({ request }) => {
      const { version, ...fields } = await readBody(routes.settings.update.body, request);
      const data = current();
      checkVersion(data.settings.version, version);
      const before = editable(data.settings);
      data.settings = { ...data.settings, ...fields, version: version + 1 };
      record(data, 'settings.updated', 'workspace', workspace.tenantId, diff(before, fields));
      await delay();
      return reply(routes.settings.update, data.settings);
    }),
  ),

  mock(
    routes.settings.setLogo,
    guarded(async ({ request }) => {
      const { attachmentId } = await readBody(routes.settings.setLogo.body, request);
      const data = current();
      const file = attachmentId === null ? undefined : uploads.get(attachmentId);
      if (attachmentId !== null && !file?.url) throw new MockProblem(409, 'attachment_not_ready');
      data.settings = {
        ...data.settings,
        logo: attachmentId !== null && file?.url ? { attachmentId, url: file.url } : null,
      };
      record(data, 'settings.logo_changed', 'workspace', workspace.tenantId);
      return reply(routes.settings.setLogo, data.settings);
    }),
  ),

  mock(routes.branches.list, ({ request }) => {
    const { status } = readQuery(routes.branches.list.query, request);
    const items = current()
      .branches.filter((branch) => (status === 'active') === (branch.archivedAt === null))
      .toSorted((a, b) => a.code.localeCompare(b.code));
    return reply(routes.branches.list, { items });
  }),

  mock(
    routes.branches.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.branches.create.body, request);
      const data = current();
      assertCodeFree(data, body.code);
      const created = {
        id: crypto.randomUUID(),
        ...body,
        archivedAt: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.branches.push(created);
      record(data, 'branch.created', 'branch', created.id, diff({}, body));
      await delay();
      return reply(routes.branches.create, created);
    }),
  ),

  mock(
    routes.branches.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.branches.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.branches.update.body, request);
      const data = current();
      const target = findBranch(data, id);
      checkVersion(target.version, version);
      assertCodeFree(data, fields.code, id);
      const before = {
        code: target.code,
        name: target.name,
        phone: target.phone,
        address: target.address,
      };
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'branch.updated', 'branch', id, diff(before, fields));
      await delay();
      return reply(routes.branches.update, target);
    }),
  ),

  mock(
    routes.branches.archive,
    guarded(async ({ request, params }) => {
      const { id } = routes.branches.archive.params.parse(params);
      const { version } = await readBody(routes.branches.archive.body, request);
      const data = current();
      const target = findBranch(data, id);
      checkVersion(target.version, version);
      const othersActive = data.branches.some((b) => b.id !== id && b.archivedAt === null);
      if (!othersActive) throw new MockProblem(409, 'branch_last_active');
      Object.assign(target, { archivedAt: new Date().toISOString(), version: version + 1 });
      record(data, 'branch.archived', 'branch', id);
      return reply(routes.branches.archive, target);
    }),
  ),

  mock(
    routes.branches.restore,
    guarded(async ({ request, params }) => {
      const { id } = routes.branches.restore.params.parse(params);
      const { version } = await readBody(routes.branches.restore.body, request);
      const data = current();
      const target = findBranch(data, id);
      checkVersion(target.version, version);
      Object.assign(target, { archivedAt: null, version: version + 1 });
      record(data, 'branch.restored', 'branch', id);
      return reply(routes.branches.restore, target);
    }),
  ),

  mock(routes.numberSeries.list, () =>
    reply(routes.numberSeries.list, { items: seriesList(current()) }),
  ),

  mock(
    routes.numberSeries.update,
    guarded(async ({ request, params }) => {
      const { documentType } = routes.numberSeries.update.params.parse(params);
      const { version, ...format } = await readBody(routes.numberSeries.update.body, request);
      const data = current();
      checkVersion(data.series.get(documentType)?.version ?? 0, version);
      data.series.set(documentType, { ...format, version: version + 1 });
      record(data, 'number_series.updated', 'number_series', crypto.randomUUID(), {});
      const saved = seriesList(data).find((series) => series.documentType === documentType);
      if (!saved) throw new MockProblem(404, 'not_found');
      return reply(routes.numberSeries.update, saved);
    }),
  ),

  mock(routes.audit.list, ({ request }) => {
    const query = readQuery(routes.audit.list.query, request);
    // mock-এ cursor শুধু offset (members-এর মতো) — ক্লায়েন্টের কাছে অস্বচ্ছ string
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = current().audit.filter(
      (entry) => query.entityType === undefined || entry.entityType === query.entityType,
    );
    const items = all.slice(start, start + query.limit);
    const end = start + items.length;
    return reply(routes.audit.list, { items, nextCursor: end < all.length ? String(end) : null });
  }),

  mock(routes.attachments.createUpload, async ({ request }) => {
    const body = await readBody(routes.attachments.createUpload.body, request);
    const id = crypto.randomUUID();
    uploads.set(id, { contentType: body.contentType, sizeBytes: body.sizeBytes });
    return reply(routes.attachments.createUpload, {
      attachment: { id, ...body, status: 'pending', createdAt: new Date().toISOString() },
      upload: {
        method: 'PUT',
        url: `${MOCK_STORAGE}/${id}`,
        headers: { 'content-type': body.contentType },
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    });
  }),

  // storage-এর জায়গায়: চুক্তির রুট না, তাই mock() না — সাধারণ MSW handler
  http.put(`${MOCK_STORAGE}/:id`, async ({ request, params }) => {
    const file = typeof params.id === 'string' ? uploads.get(params.id) : undefined;
    if (!file) return new HttpResponse(null, { status: 404 });
    file.url = URL.createObjectURL(await request.blob());
    await delay(600);
    return new HttpResponse(null, { status: 200 });
  }),

  mock(
    routes.attachments.complete,
    guarded(({ params }) => {
      const { id } = routes.attachments.complete.params.parse(params);
      const file = uploads.get(id);
      if (!file?.url) throw new MockProblem(409, 'upload_incomplete');
      return reply(routes.attachments.complete, {
        id,
        purpose: 'company_logo',
        fileName: 'logo',
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        status: 'ready',
        createdAt: new Date().toISOString(),
      });
    }),
  ),

  mock(
    routes.attachments.download,
    guarded(({ params }) => {
      const { id } = routes.attachments.download.params.parse(params);
      const url = uploads.get(id)?.url;
      if (!url) throw new MockProblem(409, 'attachment_not_ready');
      return reply(routes.attachments.download, {
        url,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    }),
  ),
];
