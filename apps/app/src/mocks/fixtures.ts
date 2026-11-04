import {
  type MeResponse,
  PERMISSION_KEYS,
  type Preferences,
  type SetupStatus,
} from '@omnivo/contracts';
import { z } from 'zod';

// আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): এক গার্মেন্টস আর এক ফার্মা, একই মালিক দুটোতে.
// Step 18a: fixed ids, the same after every reload. The device's copy is kept per workspace and
// person, so a reload finds its copy again, and the e2e tests can set the device up before the
// app starts (e2e/helpers.ts).
export const WORKSPACES = [
  {
    tenantId: '96d949e2-58a4-4d50-b52d-bf4619d130d1',
    name: 'Rahman Garments Ltd.',
    slug: 'rahman-garments',
  },
  { tenantId: 'e4ab91bc-b92e-4999-a5c4-538dec638d15', name: 'Karim Pharma', slug: 'karim-pharma' },
] as const;

export type Workspace = (typeof WORKSPACES)[number];

// The head office of each workspace, the branch the e2e tests' device is in
export const HEAD_OFFICES = {
  'rahman-garments': 'cf6fbdda-60ec-46a9-a809-e26624969bf7',
  'karim-pharma': '07cf0e23-ec6c-4505-9410-c80aa2fc4aef',
} as const satisfies Record<Workspace['slug'], string>;

const owner = {
  id: '71551ffc-0452-4c39-a3ec-62801c29834e',
  email: 'farhana@rahmangarments.com',
  fullName: 'Farhana Rahman',
};

export const OWNER = owner;

// Owner = catalog-এর সব permission (আসল API-র মতো, কোড থেকে)
export const OWNER_PERMISSIONS = [...PERMISSION_KEYS].sort();

// Step 21a: the owner sees every card of the Overview, so a test of what a store keeper sees needs
// someone else. A test leaves a role and its permissions in localStorage under this key before the
// app starts (e2e/helpers.ts → actAs), and the mock's /me answers with them; the same person
// signs in, only their role changes. The handlers run in the page, so they read the page's
// storage. Mock mode only: nothing in the app reads this key.
export const MOCK_ROLE_KEY = 'omnivo.mock.role';

export const mockRoleSchema = z.object({
  name: z.string(),
  permissions: z.array(z.enum(PERMISSION_KEYS)),
});
export type MockRole = z.infer<typeof mockRoleSchema>;

// The role a test left, or null for the owner. A key that does not parse is the owner too: a mock
// must not break `pnpm dev:mock` over a stale key.
export function mockRole(): MockRole | null {
  try {
    const saved = localStorage.getItem(MOCK_ROLE_KEY);
    if (saved === null) return null;
    const parsed = mockRoleSchema.safeParse(JSON.parse(saved));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function meIn(
  workspace: Workspace,
  companyName: string,
  preferences: Preferences,
  setupStatus: SetupStatus,
): MeResponse {
  const role = mockRole();
  return {
    user: owner,
    tenant: { id: workspace.tenantId, name: companyName, slug: workspace.slug, setupStatus },
    roles: [role?.name ?? 'Owner'],
    permissions: role ? [...role.permissions].sort() : OWNER_PERMISSIONS,
    memberships: [...WORKSPACES],
    preferences,
  };
}
