import {
  type Account,
  accountTypeFits,
  type AuthSession,
  type ErrorCode,
  type Preferences,
  type ProductCategory,
  routes,
  type Settings,
  STOCK_ACCOUNT_USES,
} from '@omnivo/contracts';
import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw';

import { API_URL } from '../lib/api';
import { meIn, OWNER, WORKSPACES, type Workspace } from './fixtures';
import { mock, MockProblem, problem, readBody, readQuery, reply } from './mock';
import {
  assertCanChange,
  assertRoleNameFree,
  demoPreview,
  expiry,
  findMember,
  findRole,
  isOpen,
  MOCK_SEND_DELAY_MS,
  newToken,
  roleList,
  toInvitation,
  toRole,
} from './people-data';
import {
  assertAccountCodeFree,
  assertNotLocked,
  codeOf,
  findAccount,
  parentFor,
} from './accounting-data';
import {
  checkLines,
  findEntry,
  ledgerOf,
  openingOf,
  postDraft,
  postNew,
  replaceDraft,
  reverseEntry,
  saveOpening,
  setLockDate,
  sortedEntries,
  summaryOf,
  writeDraft,
} from './journal-data';
import {
  balanceSheetOf,
  closeYear,
  createExport,
  exportUrl,
  fiscalYearsOf,
  profitAndLossOf,
  reopenYear,
  settleExports,
  toExport,
  trialBalanceOf,
} from './report-data';
import {
  findProduct,
  IMPORT_DELAY_MS,
  listProducts,
  type MockImport,
  saveProduct,
  settleImports,
  productSummaryOf,
  toImport,
} from './product-data';
import { settleSetup, startSetup } from './setup-data';
import {
  batchReport,
  cardOf,
  findAdjustment,
  findRevaluation,
  findTransfer,
  listStock,
  movementsOf,
  postAdjustment,
  receiveTransfer,
  reorderReport,
  revalue,
  saveAdjustment,
  saveTransfer,
  sendTransfer,
  setLevel,
  valuationList,
  valuationSummary,
  warehouse as newWarehouse,
} from './stock-data';
import {
  assertCodeFree,
  checkVersion,
  dataOf,
  diff,
  findBranch,
  record,
  seriesList,
  startFresh,
} from './workspace-data';

// mock সার্ভারের অবস্থা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে
let signedIn = true;
let workspace: Workspace = WORKSPACES[0];
let preferences: Preferences = { language: null, theme: 'system' };

// আপলোড হওয়া ফাইল: storage-এর বদলে ব্রাউজারের blob URL — <img src>-এ সরাসরি বসে
const uploads = new Map<string, { contentType: string; sizeBytes: number; url?: string }>();
const MOCK_STORAGE = `${API_URL}/mock-storage`;

// settleSetup / settleExports: a started setup or an asked-for export "finishes" on the first read
// after its delay, like the worker would
function current() {
  const data = dataOf(workspace);
  settleSetup(data);
  settleExports(data);
  settleImports(data.catalog, (type, params) => {
    data.notifications.unshift({
      id: crypto.randomUUID(),
      type,
      params,
      readAt: null,
      createdAt: new Date().toISOString(),
    });
  });
  return data;
}

function me() {
  const data = current();
  return meIn(workspace, data.settings.companyName, preferences, data.setup.status);
}

// handler-এর ভেতরে MockProblem ছুড়লেই আসল API-র মতো problem response — প্রতিটা নিয়মে আলাদা
// if/return লিখতে হয় না
function guarded(resolver: HttpResponseResolver): HttpResponseResolver {
  return async (info) => {
    try {
      return await resolver(info);
    } catch (error) {
      if (error instanceof MockProblem) {
        return problem(error.status, error.code, error.fieldErrors, error.params);
      }
      throw error;
    }
  };
}

// audit-এর "আগের মান" — ফর্মের ঘরগুলো
function editable(settings: Settings) {
  return {
    allowNegativeStock: settings.allowNegativeStock,
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

// The API's sibling rule: two "Knit" in one place would be two answers to "which one?"
function assertCategoryPlace(
  categories: readonly ProductCategory[],
  parentId: string | null,
  name: string,
  except?: string,
): void {
  if (parentId !== null && !categories.some((category) => category.id === parentId)) {
    throw new MockProblem(409, 'category_parent_invalid', {
      parentId: ['category_parent_invalid'],
    });
  }
  const taken = categories.some(
    (category) =>
      category.id !== except &&
      category.parentId === parentId &&
      category.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new MockProblem(409, 'category_name_taken', { name: ['category_name_taken'] });
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
    // A new workspace: setup 'pending', so the app goes on to the onboarding wizard
    workspace = WORKSPACES[0];
    startFresh(workspace, body.companyName);
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
    const sorted = current().people.members.toSorted((a, b) =>
      a.fullName.localeCompare(b.fullName),
    );
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

  mock(
    routes.members.updateRoles,
    guarded(async ({ request, params }) => {
      const { id } = routes.members.updateRoles.params.parse(params);
      const { roleIds, version } = await readBody(routes.members.updateRoles.body, request);
      const data = current();
      const member = findMember(data.people, id);
      checkVersion(member.version, version);
      assertCanChange(data.people, member, roleIds);
      const before = member.roles.map((role) => role.name).join(', ') || null;
      member.roles = roleIds
        .map((roleId) => findRole(data.people, roleId))
        .map((role) => ({ id: role.id, name: role.name }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      member.version += 1;
      const after = member.roles.map((role) => role.name).join(', ') || null;
      record(data, 'member.roles_changed', 'member', id, { roles: { from: before, to: after } });
      await delay();
      return reply(routes.members.updateRoles, member);
    }),
  ),

  mock(
    routes.members.remove,
    guarded(({ request, params }) => {
      const { id } = routes.members.remove.params.parse(params);
      const { version } = readQuery(routes.members.remove.query, request);
      const data = current();
      const member = findMember(data.people, id);
      checkVersion(member.version, version);
      assertCanChange(data.people, member, []);
      data.people.members = data.people.members.filter((other) => other.membershipId !== id);
      record(data, 'member.removed', 'member', id, { email: { from: member.email, to: null } });
      return reply(routes.members.remove, undefined);
    }),
  ),

  mock(routes.roles.list, () => reply(routes.roles.list, { items: roleList(current().people) })),

  mock(
    routes.roles.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.roles.create.body, request);
      const data = current();
      assertRoleNameFree(data.people, body.name);
      const created = {
        id: crypto.randomUUID(),
        ...body,
        kind: 'custom' as const,
        permissions: [],
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.people.roles.push(created);
      record(data, 'role.created', 'role', created.id, diff({}, body));
      await delay();
      return reply(routes.roles.create, toRole(data.people, created));
    }),
  ),

  mock(
    routes.roles.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.roles.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.roles.update.body, request);
      const data = current();
      const target = findRole(data.people, id);
      if (target.kind === 'owner') throw new MockProblem(409, 'owner_role_locked');
      checkVersion(target.version, version);
      assertRoleNameFree(data.people, fields.name, id);
      const before = { name: target.name, description: target.description };
      Object.assign(target, fields, { version: version + 1 });
      // সদস্যের তালিকায় রোলের নামও নতুন
      for (const member of data.people.members) {
        for (const held of member.roles) if (held.id === id) held.name = fields.name;
      }
      record(data, 'role.updated', 'role', id, diff(before, fields));
      return reply(routes.roles.update, toRole(data.people, target));
    }),
  ),

  mock(
    routes.roles.remove,
    guarded(({ request, params }) => {
      const { id } = routes.roles.remove.params.parse(params);
      const { version } = readQuery(routes.roles.remove.query, request);
      const data = current();
      const target = findRole(data.people, id);
      if (target.kind === 'owner') throw new MockProblem(409, 'owner_role_locked');
      checkVersion(target.version, version);
      const inUse =
        data.people.members.some((member) => member.roles.some((held) => held.id === id)) ||
        data.people.invitations.some(
          (invitation) => isOpen(invitation) && invitation.roles.some((held) => held.id === id),
        );
      if (inUse) throw new MockProblem(409, 'role_in_use');
      data.people.roles = data.people.roles.filter((other) => other.id !== id);
      record(data, 'role.deleted', 'role', id, { name: { from: target.name, to: null } });
      return reply(routes.roles.remove, undefined);
    }),
  ),

  mock(
    routes.roles.updateMatrix,
    guarded(async ({ request }) => {
      const body = await readBody(routes.roles.updateMatrix.body, request);
      const data = current();
      // আসল API-র মতো সব-নয়-কিছুই-না: আগে সব যাচাই, তারপর লেখা
      const targets = body.roles.map((change) => {
        const target = findRole(data.people, change.id);
        if (target.kind === 'owner') throw new MockProblem(409, 'owner_role_locked');
        checkVersion(target.version, change.version);
        return { target, change };
      });
      for (const { target, change } of targets) {
        const changes = diff(
          Object.fromEntries(target.permissions.map((key) => [key, true])),
          Object.fromEntries(change.permissions.map((key) => [key, true])),
        );
        for (const key of target.permissions) {
          if (!change.permissions.includes(key)) changes[key] = { from: true, to: false };
        }
        target.permissions = change.permissions;
        target.version += 1;
        record(data, 'role.permissions_changed', 'role', target.id, changes);
      }
      await delay();
      return reply(routes.roles.updateMatrix, { items: roleList(data.people) });
    }),
  ),

  mock(routes.invitations.list, () =>
    reply(routes.invitations.list, {
      items: current().people.invitations.filter(isOpen).map(toInvitation),
    }),
  ),

  mock(
    routes.invitations.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.invitations.create.body, request);
      const data = current();
      if (data.people.members.some((member) => member.email === body.email)) {
        throw new MockProblem(409, 'already_member', { email: ['already_member'] });
      }
      if (data.people.invitations.some((other) => isOpen(other) && other.email === body.email)) {
        throw new MockProblem(409, 'already_invited', { email: ['already_invited'] });
      }
      const invitation = {
        id: crypto.randomUUID(),
        email: body.email,
        roles: body.roleIds.map((roleId) => {
          const held = findRole(data.people, roleId);
          return { id: held.id, name: held.name };
        }),
        invitedBy: { id: OWNER.id, fullName: OWNER.fullName },
        sendsAt: Date.now() + MOCK_SEND_DELAY_MS,
        expiresAt: expiry(),
        createdAt: new Date().toISOString(),
        version: 1,
        token: newToken(),
        acceptedAt: null,
        revokedAt: null,
      };
      data.people.invitations.unshift(invitation);
      record(data, 'member.invited', 'invitation', invitation.id, {
        email: { from: null, to: invitation.email },
      });
      // ইমেইলের বদলে console — `pnpm dev:mock`-এ লিংকটা খুলে join পেজ দেখা যায়
      console.info(`[mock] invitation link: ${window.location.origin}/invite#${invitation.token}`);
      await delay();
      return reply(routes.invitations.create, toInvitation(invitation));
    }),
  ),

  mock(
    routes.invitations.resend,
    guarded(async ({ request, params }) => {
      const { id } = routes.invitations.resend.params.parse(params);
      const { version } = await readBody(routes.invitations.resend.body, request);
      const invitation = current().people.invitations.find(
        (candidate) => candidate.id === id && isOpen(candidate),
      );
      if (!invitation) throw new MockProblem(404, 'not_found');
      checkVersion(invitation.version, version);
      Object.assign(invitation, {
        token: newToken(),
        expiresAt: expiry(),
        sendsAt: Date.now() + MOCK_SEND_DELAY_MS,
        version: version + 1,
      });
      console.info(`[mock] invitation link: ${window.location.origin}/invite#${invitation.token}`);
      return reply(routes.invitations.resend, toInvitation(invitation));
    }),
  ),

  mock(
    routes.invitations.revoke,
    guarded(({ request, params }) => {
      const { id } = routes.invitations.revoke.params.parse(params);
      const { version } = readQuery(routes.invitations.revoke.query, request);
      const invitation = current().people.invitations.find(
        (candidate) => candidate.id === id && isOpen(candidate),
      );
      if (!invitation) throw new MockProblem(404, 'not_found');
      checkVersion(invitation.version, version);
      Object.assign(invitation, { revokedAt: new Date().toISOString(), version: version + 1 });
      return reply(routes.invitations.revoke, undefined);
    }),
  ),

  mock(
    routes.invitations.lookup,
    guarded(async ({ request }) => {
      const { token } = await readBody(routes.invitations.lookup.body, request);
      const invitation = current().people.invitations.find(
        (candidate) => candidate.token === token && isOpen(candidate),
      );
      const preview = invitation
        ? {
            workspace: { name: workspace.name, slug: workspace.slug },
            email: invitation.email,
            invitedBy: invitation.invitedBy?.fullName ?? null,
            accountExists: false,
            expiresAt: invitation.expiresAt,
          }
        : demoPreview(token, workspace);
      if (!preview) throw new MockProblem(404, 'invitation_invalid');
      await delay();
      return reply(routes.invitations.lookup, preview);
    }),
  ),

  mock(
    routes.invitations.accept,
    guarded(async ({ request }) => {
      const body = await readBody(routes.invitations.accept.body, request);
      const invitation = current().people.invitations.find(
        (candidate) => candidate.token === body.token && isOpen(candidate),
      );
      if (!invitation && !demoPreview(body.token, workspace)) {
        throw new MockProblem(404, 'invitation_invalid');
      }
      if (body.account === 'existing' && body.password === 'wrong-password') {
        throw new MockProblem(401, 'invalid_credentials');
      }
      if (invitation) invitation.acceptedAt = new Date().toISOString();
      await delay();
      // mock-এ "আমি" সবসময় OWNER — গ্রহণের পরে একই ড্যাশবোর্ড, শুধু পথটা দেখার জন্য
      signedIn = true;
      return reply(routes.invitations.accept, session());
    }),
  ),

  mock(routes.settings.get, () => reply(routes.settings.get, current().settings)),

  mock(
    routes.settings.update,
    guarded(async ({ request }) => {
      const { version, ...fields } = await readBody(routes.settings.update.body, request);
      const data = current();
      checkVersion(data.settings.version, version);
      if (
        fields.baseCurrency !== data.settings.baseCurrency &&
        data.journal.entries.some((entry) => entry.status === 'posted')
      ) {
        throw new MockProblem(409, 'base_currency_locked', {
          baseCurrency: ['base_currency_locked'],
        });
      }
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

  mock(routes.accounts.list, () =>
    reply(routes.accounts.list, {
      items: current().accounts.toSorted((a, b) => a.code.localeCompare(b.code)),
    }),
  ),

  mock(
    routes.accounts.get,
    guarded(({ params }) => {
      const { id } = routes.accounts.get.params.parse(params);
      return reply(routes.accounts.get, findAccount(current().accounts, id));
    }),
  ),

  mock(
    routes.accounts.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.accounts.create.body, request);
      const data = current();
      const parent = parentFor(data.accounts, body.parentId);
      assertAccountCodeFree(data.accounts, body.code);
      const created = {
        ...body,
        id: crypto.randomUUID(),
        type: parent.type,
        purpose: null,
        archivedAt: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.accounts.push(created);
      record(
        data,
        'account.created',
        'account',
        created.id,
        diff(
          {},
          { code: body.code, name: body.name, description: body.description, parent: parent.code },
        ),
      );
      await delay();
      return reply(routes.accounts.create, created);
    }),
  ),

  mock(
    routes.accounts.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.accounts.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.accounts.update.body, request);
      const data = current();
      const target = findAccount(data.accounts, id);
      checkVersion(target.version, version);
      if (fields.parentId !== target.parentId) {
        if (fields.parentId === null) throw new MockProblem(409, 'account_parent_invalid');
        parentFor(data.accounts, fields.parentId, target);
      }
      assertAccountCodeFree(data.accounts, fields.code, id);
      const snapshot = (account: Account) => ({
        code: account.code,
        name: account.name,
        description: account.description,
        parent: codeOf(data.accounts, account.parentId),
      });
      const before = snapshot(target);
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'account.updated', 'account', id, diff(before, snapshot(target)));
      await delay();
      return reply(routes.accounts.update, target);
    }),
  ),

  mock(
    routes.accounts.archive,
    guarded(async ({ request, params }) => {
      const { id } = routes.accounts.archive.params.parse(params);
      const { version } = await readBody(routes.accounts.archive.body, request);
      const data = current();
      const target = findAccount(data.accounts, id);
      checkVersion(target.version, version);
      assertNotLocked(target);
      // Chosen in Settings → Inventory (step 14), like the API
      if (Object.values(current().stockAccounts).includes(target.id)) {
        throw new MockProblem(409, 'account_used_by_stock');
      }
      if (data.accounts.some((child) => child.parentId === id && child.archivedAt === null)) {
        throw new MockProblem(409, 'account_has_active_children');
      }
      Object.assign(target, { archivedAt: new Date().toISOString(), version: version + 1 });
      record(data, 'account.archived', 'account', id);
      return reply(routes.accounts.archive, target);
    }),
  ),

  mock(
    routes.accounts.restore,
    guarded(async ({ request, params }) => {
      const { id } = routes.accounts.restore.params.parse(params);
      const { version } = await readBody(routes.accounts.restore.body, request);
      const data = current();
      const target = findAccount(data.accounts, id);
      checkVersion(target.version, version);
      const parent = data.accounts.find((account) => account.id === target.parentId);
      if (parent && parent.archivedAt !== null) {
        throw new MockProblem(409, 'account_parent_archived');
      }
      Object.assign(target, { archivedAt: null, version: version + 1 });
      record(data, 'account.restored', 'account', id);
      return reply(routes.accounts.restore, target);
    }),
  ),

  mock(
    routes.accounts.remove,
    guarded(({ request, params }) => {
      const { id } = routes.accounts.remove.params.parse(params);
      const { version } = readQuery(routes.accounts.remove.query, request);
      const data = current();
      const target = findAccount(data.accounts, id);
      checkVersion(target.version, version);
      assertNotLocked(target);
      // Chosen in Settings → Inventory (step 14), like the API
      if (Object.values(current().stockAccounts).includes(target.id)) {
        throw new MockProblem(409, 'account_used_by_stock');
      }
      if (data.accounts.some((child) => child.parentId === id)) {
        throw new MockProblem(409, 'account_has_children');
      }
      if (data.journal.entries.some((entry) => entry.lines.some((line) => line.accountId === id))) {
        throw new MockProblem(409, 'account_in_use');
      }
      data.accounts = data.accounts.filter((account) => account.id !== id);
      record(data, 'account.deleted', 'account', id, {
        code: { from: target.code, to: null },
        name: { from: target.name, to: null },
      });
      return reply(routes.accounts.remove, undefined);
    }),
  ),

  mock(routes.journal.list, ({ request }) => {
    const query = readQuery(routes.journal.list.query, request);
    // The mock's cursor is an offset, like its other lists
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = sortedEntries(current()).filter(
      (entry) => query.status === undefined || entry.status === query.status,
    );
    const items = all.slice(start, start + query.limit).map(summaryOf);
    const end = start + items.length;
    return reply(routes.journal.list, { items, nextCursor: end < all.length ? String(end) : null });
  }),

  mock(
    routes.journal.get,
    guarded(({ params }) => {
      const { id } = routes.journal.get.params.parse(params);
      return reply(routes.journal.get, findEntry(current(), id));
    }),
  ),

  mock(
    routes.journal.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.journal.create.body, request);
      const data = current();
      checkLines(data, body.lines);
      const entry = body.post ? postNew(data, body) : writeDraft(data, body);
      record(data, 'journal.created', 'journal_entry', entry.id);
      if (body.post) {
        record(data, 'journal.posted', 'journal_entry', entry.id, {
          number: { from: null, to: entry.number },
        });
      }
      await delay();
      return reply(routes.journal.create, entry);
    }),
  ),

  mock(
    routes.journal.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.journal.update.params.parse(params);
      const { version, post, ...fields } = await readBody(routes.journal.update.body, request);
      const data = current();
      const entry = findEntry(data, id);
      if (entry.status !== 'draft') throw new MockProblem(409, 'journal_not_draft');
      checkVersion(entry.version, version);
      checkLines(data, fields.lines);
      // All or nothing, like the API's transaction: post a copy, keep it only if it posts
      const before = structuredClone(entry);
      replaceDraft(entry, fields);
      if (post) {
        try {
          postDraft(data, entry);
        } catch (error) {
          Object.assign(entry, before);
          throw error;
        }
      }
      record(data, 'journal.updated', 'journal_entry', id);
      await delay();
      return reply(routes.journal.update, entry);
    }),
  ),

  mock(
    routes.journal.remove,
    guarded(({ request, params }) => {
      const { id } = routes.journal.remove.params.parse(params);
      const { version } = readQuery(routes.journal.remove.query, request);
      const data = current();
      const entry = findEntry(data, id);
      if (entry.status !== 'draft') throw new MockProblem(409, 'journal_not_draft');
      checkVersion(entry.version, version);
      data.journal.entries = data.journal.entries.filter((item) => item.id !== id);
      record(data, 'journal.deleted', 'journal_entry', id);
      return reply(routes.journal.remove, undefined);
    }),
  ),

  mock(
    routes.journal.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.journal.post.params.parse(params);
      const { version } = await readBody(routes.journal.post.body, request);
      const data = current();
      const entry = findEntry(data, id);
      if (entry.status !== 'draft') throw new MockProblem(409, 'journal_not_draft');
      checkVersion(entry.version, version);
      postDraft(data, entry);
      record(data, 'journal.posted', 'journal_entry', id, {
        number: { from: null, to: entry.number },
      });
      return reply(routes.journal.post, entry);
    }),
  ),

  mock(
    routes.journal.reverse,
    guarded(async ({ request, params }) => {
      const { id } = routes.journal.reverse.params.parse(params);
      const { version, date } = await readBody(routes.journal.reverse.body, request);
      const data = current();
      const entry = findEntry(data, id);
      checkVersion(entry.version, version);
      const reversal = reverseEntry(data, entry, date);
      record(data, 'journal.reversed', 'journal_entry', id, {
        reversal: { from: null, to: reversal.number },
      });
      await delay();
      return reply(routes.journal.reverse, reversal);
    }),
  ),

  mock(
    routes.ledger.get,
    guarded(({ request, params }) => {
      const { id } = routes.ledger.get.params.parse(params);
      const query = readQuery(routes.ledger.get.query, request);
      return reply(routes.ledger.get, ledgerOf(current(), id, query));
    }),
  ),

  mock(routes.openingBalances.get, () => reply(routes.openingBalances.get, openingOf(current()))),

  mock(
    routes.openingBalances.save,
    guarded(async ({ request }) => {
      const body = await readBody(routes.openingBalances.save.body, request);
      const data = current();
      saveOpening(data, body);
      const saved = openingOf(data);
      record(data, 'journal.opening_balances_saved', 'workspace', workspace.tenantId, {
        entry: { from: null, to: saved.entry?.number ?? null },
      });
      await delay();
      return reply(routes.openingBalances.save, saved);
    }),
  ),

  mock(routes.periodLock.get, () => {
    const { journal } = current();
    return reply(routes.periodLock.get, {
      lockDate: journal.lockDate,
      version: journal.lockVersion,
    });
  }),

  mock(
    routes.periodLock.update,
    guarded(async ({ request }) => {
      const { lockDate, version } = await readBody(routes.periodLock.update.body, request);
      const data = current();
      const before = data.journal.lockDate;
      setLockDate(data, lockDate, version);
      record(data, 'books.lock_date_changed', 'workspace', workspace.tenantId, {
        lockDate: { from: before, to: lockDate },
      });
      return reply(routes.periodLock.update, {
        lockDate: data.journal.lockDate,
        version: data.journal.lockVersion,
      });
    }),
  ),

  mock(routes.reports.trialBalance, ({ request }) =>
    reply(
      routes.reports.trialBalance,
      trialBalanceOf(current(), readQuery(routes.reports.trialBalance.query, request)),
    ),
  ),

  mock(routes.reports.profitAndLoss, ({ request }) =>
    reply(
      routes.reports.profitAndLoss,
      profitAndLossOf(current(), readQuery(routes.reports.profitAndLoss.query, request)),
    ),
  ),

  mock(routes.reports.balanceSheet, ({ request }) =>
    reply(
      routes.reports.balanceSheet,
      balanceSheetOf(current(), readQuery(routes.reports.balanceSheet.query, request)),
    ),
  ),

  mock(routes.fiscalYears.list, () => reply(routes.fiscalYears.list, fiscalYearsOf(current()))),

  mock(
    routes.fiscalYears.close,
    guarded(async ({ request }) => {
      const { end } = await readBody(routes.fiscalYears.close.body, request);
      return reply(routes.fiscalYears.close, closeYear(current(), end));
    }),
  ),

  mock(
    routes.fiscalYears.reopen,
    guarded(async ({ request }) => {
      const { end } = await readBody(routes.fiscalYears.reopen.body, request);
      return reply(routes.fiscalYears.reopen, reopenYear(current(), end));
    }),
  ),

  mock(
    routes.reportExports.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.reportExports.create.body, request);
      return reply(routes.reportExports.create, createExport(current(), body));
    }),
  ),

  mock(routes.reportExports.list, () =>
    reply(routes.reportExports.list, {
      items: current().exports.map(toExport),
      nextCursor: null,
    }),
  ),

  mock(
    routes.reportExports.download,
    guarded(({ params }) => {
      const { id } = routes.reportExports.download.params.parse(params);
      const item = current().exports.find((candidate) => candidate.id === id);
      if (!item) throw new MockProblem(404, 'not_found');
      if (item.status !== 'ready') throw new MockProblem(409, 'export_not_ready');
      return reply(routes.reportExports.download, {
        url: exportUrl(item),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
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

  mock(routes.setup.get, () => reply(routes.setup.get, current().setup)),

  mock(
    routes.setup.start,
    guarded(async ({ request }) => {
      const { industry } = await readBody(routes.setup.start.body, request);
      await delay();
      return reply(routes.setup.start, startSetup(current(), industry));
    }),
  ),

  mock(
    routes.setup.retry,
    guarded(() => {
      const data = current();
      if (data.setup.status !== 'failed') throw new MockProblem(409, 'setup_not_failed');
      return reply(routes.setup.retry, data.setup);
    }),
  ),

  mock(routes.notifications.list, ({ request }) => {
    const query = readQuery(routes.notifications.list.query, request);
    // mock-এ cursor শুধু offset (members-এর মতো)
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = current().notifications;
    const items = all.slice(start, start + query.limit);
    const end = start + items.length;
    return reply(routes.notifications.list, {
      items,
      nextCursor: end < all.length ? String(end) : null,
    });
  }),

  mock(routes.notifications.unreadCount, () =>
    reply(routes.notifications.unreadCount, {
      count: current().notifications.filter((item) => item.readAt === null).length,
    }),
  ),

  mock(
    routes.notifications.markRead,
    guarded(({ params }) => {
      const { id } = routes.notifications.markRead.params.parse(params);
      const found = current().notifications.find((item) => item.id === id);
      if (!found) throw new MockProblem(404, 'not_found');
      found.readAt ??= new Date().toISOString();
      return reply(routes.notifications.markRead, undefined);
    }),
  ),

  mock(routes.notifications.markAllRead, () => {
    const readAt = new Date().toISOString();
    for (const item of current().notifications) item.readAt ??= readAt;
    return reply(routes.notifications.markAllRead, undefined);
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

  // ---------------------------------------------------------------------------------------------
  // Units, categories, custom fields, products and imports (step 12)

  mock(routes.units.list, () => reply(routes.units.list, { items: current().catalog.units })),

  mock(
    routes.units.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.units.create.body, request);
      const data = current();
      if (data.catalog.units.some((unit) => unit.code.toLowerCase() === body.code.toLowerCase())) {
        throw new MockProblem(409, 'unit_code_taken', { code: ['unit_code_taken'] });
      }
      const created = {
        id: crypto.randomUUID(),
        ...body,
        ratio: body.ratio === null ? null : Number(body.ratio).toFixed(6),
        archivedAt: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.catalog.units.push(created);
      record(
        data,
        'unit.created',
        'unit',
        created.id,
        diff({}, { code: body.code, name: body.name }),
      );
      return reply(routes.units.create, created);
    }),
  ),

  mock(
    routes.units.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.units.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.units.update.body, request);
      const data = current();
      const target = data.catalog.units.find((unit) => unit.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      if (
        data.catalog.units.some(
          (unit) => unit.id !== id && unit.code.toLowerCase() === fields.code.toLowerCase(),
        )
      ) {
        throw new MockProblem(409, 'unit_code_taken', { code: ['unit_code_taken'] });
      }
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'unit.updated', 'unit', id);
      return reply(routes.units.update, target);
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.units[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.units[action].params.parse(params);
        const { version } = await readBody(routes.units[action].body, request);
        const data = current();
        const target = data.catalog.units.find((unit) => unit.id === id);
        if (!target) throw new MockProblem(404, 'not_found');
        checkVersion(target.version, version);
        Object.assign(target, {
          archivedAt: action === 'archive' ? new Date().toISOString() : null,
          version: version + 1,
        });
        record(data, action === 'archive' ? 'unit.archived' : 'unit.restored', 'unit', id);
        return reply(routes.units[action], target);
      }),
    ),
  ),

  mock(
    routes.units.remove,
    guarded(({ request, params }) => {
      const { id } = routes.units.remove.params.parse(params);
      const { version } = readQuery(routes.units.remove.query, request);
      const data = current();
      const target = data.catalog.units.find((unit) => unit.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      const used = data.catalog.products.some(
        (item) => item.baseUnitId === id || item.units.some((pack) => pack.unitId === id),
      );
      if (used) throw new MockProblem(409, 'unit_in_use');
      data.catalog.units = data.catalog.units.filter((unit) => unit.id !== id);
      record(data, 'unit.deleted', 'unit', id);
      return reply(routes.units.remove, undefined);
    }),
  ),

  mock(routes.productCategories.list, () => {
    const { categories, products } = current().catalog;
    return reply(routes.productCategories.list, {
      items: categories.map((category) => ({
        ...category,
        productCount: products.filter((item) => item.categoryId === category.id).length,
      })),
    });
  }),

  mock(
    routes.productCategories.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.productCategories.create.body, request);
      const data = current();
      assertCategoryPlace(data.catalog.categories, body.parentId, body.name);
      const created = {
        id: crypto.randomUUID(),
        ...body,
        productCount: 0,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.catalog.categories.push(created);
      record(data, 'product_category.created', 'product_category', created.id);
      return reply(routes.productCategories.create, created);
    }),
  ),

  mock(
    routes.productCategories.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.productCategories.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.productCategories.update.body, request);
      const data = current();
      const target = data.catalog.categories.find((category) => category.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      // Walk up from the new parent: meeting the category itself means a loop
      for (
        let above = fields.parentId;
        above !== null;
        above = data.catalog.categories.find((category) => category.id === above)?.parentId ?? null
      ) {
        if (above === id) {
          throw new MockProblem(409, 'category_parent_loop', {
            parentId: ['category_parent_loop'],
          });
        }
      }
      assertCategoryPlace(data.catalog.categories, fields.parentId, fields.name, id);
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'product_category.updated', 'product_category', id);
      return reply(routes.productCategories.update, {
        ...target,
        productCount: data.catalog.products.filter((item) => item.categoryId === id).length,
      });
    }),
  ),

  mock(
    routes.productCategories.remove,
    guarded(({ request, params }) => {
      const { id } = routes.productCategories.remove.params.parse(params);
      const { version } = readQuery(routes.productCategories.remove.query, request);
      const data = current();
      const target = data.catalog.categories.find((category) => category.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      if (data.catalog.categories.some((category) => category.parentId === id)) {
        throw new MockProblem(409, 'category_has_children');
      }
      if (data.catalog.products.some((item) => item.categoryId === id)) {
        throw new MockProblem(409, 'category_in_use');
      }
      data.catalog.categories = data.catalog.categories.filter((category) => category.id !== id);
      record(data, 'product_category.deleted', 'product_category', id);
      return reply(routes.productCategories.remove, undefined);
    }),
  ),

  mock(routes.customFields.list, () =>
    reply(routes.customFields.list, { items: current().catalog.fields }),
  ),

  mock(
    routes.customFields.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.customFields.create.body, request);
      const data = current();
      if (data.catalog.fields.some((field) => field.key === body.key)) {
        throw new MockProblem(409, 'custom_field_key_taken', { key: ['custom_field_key_taken'] });
      }
      const created = {
        id: crypto.randomUUID(),
        ...body,
        options: body.type === 'select' ? body.options : [],
        required: body.type === 'boolean' ? false : body.required,
        archivedAt: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.catalog.fields.push(created);
      record(data, 'custom_field.created', 'custom_field', created.id);
      return reply(routes.customFields.create, created);
    }),
  ),

  mock(
    routes.customFields.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.customFields.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.customFields.update.body, request);
      const data = current();
      const target = data.catalog.fields.find((field) => field.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      if (target.type === 'select' && fields.options.length === 0) {
        throw new MockProblem(400, 'invalid_input', { options: ['custom_field_options_required'] });
      }
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'custom_field.updated', 'custom_field', id);
      return reply(routes.customFields.update, target);
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.customFields[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.customFields[action].params.parse(params);
        const { version } = await readBody(routes.customFields[action].body, request);
        const data = current();
        const target = data.catalog.fields.find((field) => field.id === id);
        if (!target) throw new MockProblem(404, 'not_found');
        checkVersion(target.version, version);
        Object.assign(target, {
          archivedAt: action === 'archive' ? new Date().toISOString() : null,
          version: version + 1,
        });
        record(
          data,
          action === 'archive' ? 'custom_field.archived' : 'custom_field.restored',
          'custom_field',
          id,
        );
        return reply(routes.customFields[action], target);
      }),
    ),
  ),

  mock(routes.products.list, async ({ request }) => {
    const query = readQuery(routes.products.list.query, request);
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = listProducts(current().catalog, query);
    const items = all.slice(start, start + query.limit).map(productSummaryOf);
    const end = start + items.length;
    // A short wait on later pages: "Loading more…" can be seen while scrolling
    if (start > 0) await delay(300);
    return reply(routes.products.list, {
      items,
      nextCursor: end < all.length ? String(end) : null,
    });
  }),

  mock(
    routes.products.get,
    guarded(({ params }) => {
      const { id } = routes.products.get.params.parse(params);
      return reply(routes.products.get, findProduct(current().catalog, id));
    }),
  ),

  mock(
    routes.products.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.products.create.body, request);
      const data = current();
      const saved = saveProduct(data.catalog, body);
      data.catalog.products.push(saved);
      record(
        data,
        'product.created',
        'product',
        saved.id,
        diff({}, { code: saved.code, name: saved.name }),
      );
      await delay();
      return reply(routes.products.create, saved);
    }),
  ),

  mock(
    routes.products.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.products.update.params.parse(params);
      const { version, ...body } = await readBody(routes.products.update.body, request);
      const data = current();
      const target = findProduct(data.catalog, id);
      checkVersion(target.version, version);
      const saved = saveProduct(data.catalog, body, target);
      data.catalog.products = data.catalog.products.map((item) => (item.id === id ? saved : item));
      record(
        data,
        'product.updated',
        'product',
        id,
        diff({ name: target.name }, { name: saved.name }),
      );
      await delay();
      return reply(routes.products.update, saved);
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.products[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.products[action].params.parse(params);
        const { version } = await readBody(routes.products[action].body, request);
        const data = current();
        const target = findProduct(data.catalog, id);
        checkVersion(target.version, version);
        Object.assign(target, {
          archivedAt: action === 'archive' ? new Date().toISOString() : null,
          version: version + 1,
          updatedAt: new Date().toISOString(),
        });
        record(data, action === 'archive' ? 'product.archived' : 'product.restored', 'product', id);
        return reply(routes.products[action], target);
      }),
    ),
  ),

  mock(
    routes.products.remove,
    guarded(({ request, params }) => {
      const { id } = routes.products.remove.params.parse(params);
      const { version } = readQuery(routes.products.remove.query, request);
      const data = current();
      const target = findProduct(data.catalog, id);
      checkVersion(target.version, version);
      data.catalog.products = data.catalog.products.filter((item) => item.id !== id);
      record(data, 'product.deleted', 'product', id, diff({ name: target.name }, { name: null }));
      return reply(routes.products.remove, undefined);
    }),
  ),

  mock(routes.productImports.create, async ({ request }) => {
    const body = await readBody(routes.productImports.create.body, request);
    const item: MockImport = {
      id: crypto.randomUUID(),
      ...body,
      status: 'uploading',
      rowCount: null,
      productCount: null,
      errorCount: 0,
      errors: [],
      requestedBy: { id: OWNER.id, fullName: OWNER.fullName },
      createdAt: new Date().toISOString(),
      finishedAt: null,
      readyAt: 0,
      text: null,
    };
    current().catalog.imports.unshift(item);
    return reply(routes.productImports.create, {
      import: toImport(item),
      upload: {
        method: 'PUT',
        url: `${MOCK_STORAGE}/imports/${item.id}`,
        headers: { 'content-type': 'text/csv' },
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    });
  }),

  // The CSV goes to the pretend storage: kept as text for the pretend worker
  http.put(`${MOCK_STORAGE}/imports/:id`, async ({ request, params }) => {
    const item = current().catalog.imports.find((candidate) => candidate.id === params.id);
    if (!item) return new HttpResponse(null, { status: 404 });
    item.text = await request.text();
    await delay(400);
    return new HttpResponse(null, { status: 200 });
  }),

  mock(
    routes.productImports.start,
    guarded(({ params }) => {
      const { id } = routes.productImports.start.params.parse(params);
      const item = current().catalog.imports.find((candidate) => candidate.id === id);
      if (!item) throw new MockProblem(404, 'not_found');
      if (item.status !== 'uploading') throw new MockProblem(409, 'import_not_pending');
      if (item.text === null) throw new MockProblem(409, 'import_not_uploaded');
      Object.assign(item, { status: 'queued', readyAt: Date.now() + IMPORT_DELAY_MS });
      return reply(routes.productImports.start, toImport(item));
    }),
  ),

  mock(routes.productImports.list, () =>
    reply(routes.productImports.list, {
      items: current().catalog.imports.map(toImport),
      nextCursor: null,
    }),
  ),

  mock(
    routes.productImports.get,
    guarded(({ params }) => {
      const { id } = routes.productImports.get.params.parse(params);
      const item = current().catalog.imports.find((candidate) => candidate.id === id);
      if (!item) throw new MockProblem(404, 'not_found');
      return reply(routes.productImports.get, { ...toImport(item), errors: item.errors });
    }),
  ),

  // --- Warehouses and stock (step 13) ----------------------------------------------------------

  mock(routes.warehouses.list, ({ request }) => {
    const { status } = readQuery(routes.warehouses.list.query, request);
    const items = current()
      .stock.warehouses.filter((place) => (status === 'active') === (place.archivedAt === null))
      .toSorted((a, b) => a.code.localeCompare(b.code));
    return reply(routes.warehouses.list, { items });
  }),

  mock(
    routes.warehouses.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.warehouses.create.body, request);
      const data = current();
      if (data.stock.warehouses.some((place) => place.code === body.code)) {
        throw new MockProblem(409, 'warehouse_code_taken', { code: ['warehouse_code_taken'] });
      }
      const created = newWarehouse(body.branchId, body.code, body.name, body.address);
      data.stock.warehouses.push(created);
      record(data, 'warehouse.created', 'warehouse', created.id, diff({}, { code: created.code }));
      return reply(routes.warehouses.create, created);
    }),
  ),

  mock(
    routes.warehouses.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.warehouses.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.warehouses.update.body, request);
      const data = current();
      const target = data.stock.warehouses.find((place) => place.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      if (data.stock.warehouses.some((place) => place.code === fields.code && place.id !== id)) {
        throw new MockProblem(409, 'warehouse_code_taken', { code: ['warehouse_code_taken'] });
      }
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'warehouse.updated', 'warehouse', id);
      return reply(routes.warehouses.update, target);
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.warehouses[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.warehouses[action].params.parse(params);
        const { version } = await readBody(routes.warehouses[action].body, request);
        const data = current();
        const target = data.stock.warehouses.find((place) => place.id === id);
        if (!target) throw new MockProblem(404, 'not_found');
        checkVersion(target.version, version);
        if (action === 'archive') {
          const holds = data.stock.movements
            .filter((movement) => movement.warehouseId === id)
            .reduce((sum, movement) => sum + Number(movement.quantity), 0);
          if (holds !== 0) throw new MockProblem(409, 'warehouse_has_stock');
        }
        Object.assign(target, {
          archivedAt: action === 'archive' ? new Date().toISOString() : null,
          version: version + 1,
        });
        record(
          data,
          action === 'archive' ? 'warehouse.archived' : 'warehouse.restored',
          'warehouse',
          id,
        );
        return reply(routes.warehouses[action], target);
      }),
    ),
  ),

  mock(routes.stock.list, async ({ request }) => {
    const query = readQuery(routes.stock.list.query, request);
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = listStock(current(), query);
    const items = all.slice(start, start + query.limit);
    const end = start + items.length;
    if (start > 0) await delay(300);
    return reply(routes.stock.list, { items, nextCursor: end < all.length ? String(end) : null });
  }),

  mock(
    routes.stock.card,
    guarded(({ params }) => {
      const { id } = routes.stock.card.params.parse(params);
      return reply(routes.stock.card, cardOf(current(), id));
    }),
  ),

  mock(
    routes.stock.movements,
    guarded(({ request, params }) => {
      const { id } = routes.stock.movements.params.parse(params);
      const query = readQuery(routes.stock.movements.query, request);
      const { items, openingBalance, closingBalance } = movementsOf(current(), id, query);
      return reply(routes.stock.movements, {
        items,
        nextCursor: null,
        openingBalance,
        closingBalance,
      });
    }),
  ),

  mock(routes.stock.batches, ({ request }) => {
    const query = readQuery(routes.stock.batches.query, request);
    return reply(routes.stock.batches, { items: batchReport(current(), query), nextCursor: null });
  }),

  mock(routes.stock.reorder, ({ request }) => {
    const query = readQuery(routes.stock.reorder.query, request);
    return reply(routes.stock.reorder, {
      items: reorderReport(current(), query.warehouseId),
      nextCursor: null,
    });
  }),

  mock(
    routes.stock.setReorderLevel,
    guarded(async ({ request }) => {
      const body = await readBody(routes.stock.setReorderLevel.body, request);
      const data = current();
      const saved = setLevel(data, body);
      record(data, 'reorder_level.changed', 'reorder_level', body.variantId);
      return reply(routes.stock.setReorderLevel, saved);
    }),
  ),

  mock(routes.stockAdjustments.list, ({ request }) => {
    const query = readQuery(routes.stockAdjustments.list.query, request);
    const items = current()
      .stock.adjustments.filter(
        (adjustment) =>
          (query.status === undefined || adjustment.status === query.status) &&
          (query.warehouseId === undefined || adjustment.warehouseId === query.warehouseId),
      )
      // A whole adjustment is a summary with its lines: the client's parse drops them
      .toSorted((a, b) => b.date.localeCompare(a.date));
    return reply(routes.stockAdjustments.list, { items, nextCursor: null });
  }),

  mock(
    routes.stockAdjustments.get,
    guarded(({ params }) => {
      const { id } = routes.stockAdjustments.get.params.parse(params);
      return reply(routes.stockAdjustments.get, findAdjustment(current(), id));
    }),
  ),

  mock(
    routes.stockAdjustments.create,
    guarded(async ({ request }) => {
      const { post, ...input } = await readBody(routes.stockAdjustments.create.body, request);
      const data = current();
      const draft = saveAdjustment(data, input);
      record(data, 'stock_adjustment.created', 'stock_adjustment', draft.id);
      const saved = post ? postAdjustment(data, draft) : draft;
      await delay();
      return reply(routes.stockAdjustments.create, saved);
    }),
  ),

  mock(
    routes.stockAdjustments.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.stockAdjustments.update.params.parse(params);
      const { post, version, ...input } = await readBody(
        routes.stockAdjustments.update.body,
        request,
      );
      const data = current();
      const target = findAdjustment(data, id);
      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
      checkVersion(target.version, version);
      const draft = saveAdjustment(data, input, target);
      record(data, 'stock_adjustment.updated', 'stock_adjustment', id);
      const saved = post ? postAdjustment(data, draft) : draft;
      await delay();
      return reply(routes.stockAdjustments.update, saved);
    }),
  ),

  mock(
    routes.stockAdjustments.remove,
    guarded(({ request, params }) => {
      const { id } = routes.stockAdjustments.remove.params.parse(params);
      const { version } = readQuery(routes.stockAdjustments.remove.query, request);
      const data = current();
      const target = findAdjustment(data, id);
      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
      checkVersion(target.version, version);
      data.stock.adjustments = data.stock.adjustments.filter((row) => row.id !== id);
      record(data, 'stock_adjustment.deleted', 'stock_adjustment', id);
      return reply(routes.stockAdjustments.remove, undefined);
    }),
  ),

  mock(
    routes.stockAdjustments.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.stockAdjustments.post.params.parse(params);
      const { version } = await readBody(routes.stockAdjustments.post.body, request);
      const data = current();
      const target = findAdjustment(data, id);
      checkVersion(target.version, version);
      const posted = postAdjustment(data, target);
      record(data, 'stock_adjustment.posted', 'stock_adjustment', id);
      return reply(routes.stockAdjustments.post, posted);
    }),
  ),

  mock(routes.stockTransfers.list, ({ request }) => {
    const query = readQuery(routes.stockTransfers.list.query, request);
    const items = current()
      .stock.transfers.filter(
        (transfer) =>
          (query.status === undefined || transfer.status === query.status) &&
          (query.warehouseId === undefined ||
            transfer.fromWarehouseId === query.warehouseId ||
            transfer.toWarehouseId === query.warehouseId),
      )
      .toSorted((a, b) => b.sentOn.localeCompare(a.sentOn));
    return reply(routes.stockTransfers.list, { items, nextCursor: null });
  }),

  mock(
    routes.stockTransfers.get,
    guarded(({ params }) => {
      const { id } = routes.stockTransfers.get.params.parse(params);
      return reply(routes.stockTransfers.get, findTransfer(current(), id));
    }),
  ),

  mock(
    routes.stockTransfers.create,
    guarded(async ({ request }) => {
      const { send, ...input } = await readBody(routes.stockTransfers.create.body, request);
      const data = current();
      const draft = saveTransfer(data, input);
      record(data, 'stock_transfer.created', 'stock_transfer', draft.id);
      const saved = send ? sendTransfer(data, draft) : draft;
      await delay();
      return reply(routes.stockTransfers.create, saved);
    }),
  ),

  mock(
    routes.stockTransfers.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.stockTransfers.update.params.parse(params);
      const { send, version, ...input } = await readBody(
        routes.stockTransfers.update.body,
        request,
      );
      const data = current();
      const target = findTransfer(data, id);
      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
      checkVersion(target.version, version);
      const draft = saveTransfer(data, input, target);
      record(data, 'stock_transfer.updated', 'stock_transfer', id);
      const saved = send ? sendTransfer(data, draft) : draft;
      await delay();
      return reply(routes.stockTransfers.update, saved);
    }),
  ),

  mock(
    routes.stockTransfers.remove,
    guarded(({ request, params }) => {
      const { id } = routes.stockTransfers.remove.params.parse(params);
      const { version } = readQuery(routes.stockTransfers.remove.query, request);
      const data = current();
      const target = findTransfer(data, id);
      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
      checkVersion(target.version, version);
      data.stock.transfers = data.stock.transfers.filter((row) => row.id !== id);
      record(data, 'stock_transfer.deleted', 'stock_transfer', id);
      return reply(routes.stockTransfers.remove, undefined);
    }),
  ),

  mock(
    routes.stockTransfers.send,
    guarded(async ({ request, params }) => {
      const { id } = routes.stockTransfers.send.params.parse(params);
      const { version } = await readBody(routes.stockTransfers.send.body, request);
      const data = current();
      const target = findTransfer(data, id);
      checkVersion(target.version, version);
      const sent = sendTransfer(data, target);
      record(data, 'stock_transfer.sent', 'stock_transfer', id);
      return reply(routes.stockTransfers.send, sent);
    }),
  ),

  mock(
    routes.stockTransfers.receive,
    guarded(async ({ request, params }) => {
      const { id } = routes.stockTransfers.receive.params.parse(params);
      const { version, ...input } = await readBody(routes.stockTransfers.receive.body, request);
      const data = current();
      const target = findTransfer(data, id);
      checkVersion(target.version, version);
      const received = receiveTransfer(data, target, input);
      record(data, 'stock_transfer.received', 'stock_transfer', id);
      await delay();
      return reply(routes.stockTransfers.receive, received);
    }),
  ),

  // --- Stock values (step 14) ------------------------------------------------------------------

  mock(routes.stock.valuation, ({ request }) => {
    const query = readQuery(routes.stock.valuation.query, request);
    return reply(routes.stock.valuation, {
      items: valuationList(current(), query),
      nextCursor: null,
    });
  }),

  mock(routes.stock.valuationSummary, () =>
    reply(routes.stock.valuationSummary, valuationSummary(current())),
  ),

  mock(routes.stockRevaluations.list, () =>
    reply(routes.stockRevaluations.list, {
      items: current().stock.revaluations.map((revaluation) => ({
        id: revaluation.id,
        number: revaluation.number,
        date: revaluation.date,
        note: revaluation.note,
        lineCount: revaluation.lineCount,
        difference: revaluation.difference,
        postedAt: revaluation.postedAt,
      })),
      nextCursor: null,
    }),
  ),

  mock(
    routes.stockRevaluations.get,
    guarded(({ params }) => {
      const { id } = routes.stockRevaluations.get.params.parse(params);
      return reply(routes.stockRevaluations.get, findRevaluation(current(), id));
    }),
  ),

  mock(
    routes.stockRevaluations.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.stockRevaluations.create.body, request);
      const data = current();
      const posted = revalue(data, body);
      record(data, 'stock_revaluation.posted', 'stock_revaluation', posted.id, {
        number: { from: null, to: posted.number },
      });
      await delay();
      return reply(routes.stockRevaluations.create, posted);
    }),
  ),

  mock(routes.stockAccounts.get, () => reply(routes.stockAccounts.get, current().stockAccounts)),

  mock(
    routes.stockAccounts.update,
    guarded(async ({ request }) => {
      const body = await readBody(routes.stockAccounts.update.body, request);
      const data = current();
      // The API's rules: an active ledger of a type that fits, never the inventory account
      const fieldErrors: Record<string, ErrorCode[]> = {};
      for (const use of STOCK_ACCOUNT_USES) {
        const account = data.accounts.find((row) => row.id === body[use]);
        if (account?.purpose === 'inventory') fieldErrors[use] = ['stock_account_inventory'];
        else if (
          !account ||
          account.isGroup ||
          account.archivedAt !== null ||
          !accountTypeFits(use, account.type)
        ) {
          fieldErrors[use] = ['stock_account_invalid'];
        }
      }
      const [first] = Object.values(fieldErrors);
      if (first?.[0] !== undefined) throw new MockProblem(409, first[0], fieldErrors);
      const before = data.stockAccounts;
      data.stockAccounts = { ...body };
      record(
        data,
        'stock_accounts.changed',
        'workspace',
        crypto.randomUUID(),
        diff(
          Object.fromEntries(
            STOCK_ACCOUNT_USES.map((use) => [use, codeOf(data.accounts, before[use])]),
          ),
          Object.fromEntries(
            STOCK_ACCOUNT_USES.map((use) => [use, codeOf(data.accounts, body[use])]),
          ),
        ),
      );
      return reply(routes.stockAccounts.update, data.stockAccounts);
    }),
  ),
];
