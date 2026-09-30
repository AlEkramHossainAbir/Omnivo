import {
  type MeResponse,
  PERMISSION_KEYS,
  type Preferences,
  type SetupStatus,
} from '@omnivo/contracts';

// আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): এক গার্মেন্টস আর এক ফার্মা, একই মালিক দুটোতে
export const WORKSPACES = [
  { tenantId: crypto.randomUUID(), name: 'Rahman Garments Ltd.', slug: 'rahman-garments' },
  { tenantId: crypto.randomUUID(), name: 'Karim Pharma', slug: 'karim-pharma' },
] as const;

export type Workspace = (typeof WORKSPACES)[number];

const owner = {
  id: crypto.randomUUID(),
  email: 'farhana@rahmangarments.com',
  fullName: 'Farhana Rahman',
};

export const OWNER = owner;

// Owner = catalog-এর সব permission (আসল API-র মতো, কোড থেকে)
export const OWNER_PERMISSIONS = [...PERMISSION_KEYS].sort();

export function meIn(
  workspace: Workspace,
  companyName: string,
  preferences: Preferences,
  setupStatus: SetupStatus,
): MeResponse {
  return {
    user: owner,
    tenant: { id: workspace.tenantId, name: companyName, slug: workspace.slug, setupStatus },
    roles: ['Owner'],
    permissions: OWNER_PERMISSIONS,
    memberships: [...WORKSPACES],
    preferences,
  };
}
