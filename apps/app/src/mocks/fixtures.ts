import type { Member, MeResponse } from '@omnivo/contracts';

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

export function meIn(workspace: Workspace): MeResponse {
  return {
    user: owner,
    tenant: { id: workspace.tenantId, name: workspace.name, slug: workspace.slug },
    roles: ['Owner'],
    permissions: ['core.role.manage', 'core.user.invite', 'core.user.read'],
    memberships: [...WORKSPACES],
  };
}

const FIRST = ['Abdul', 'Nasrin', 'Shafiq', 'Rupa', 'Tanvir', 'Sharmin', 'Mahbub', 'Farzana'];
const LAST = ['Karim', 'Akter', 'Islam', 'Hossain', 'Rahman', 'Chowdhury', 'Sarkar', 'Begum'];
const ROLES = [['Accountant'], ['Merchandiser'], ['Store keeper'], [], ['Production manager']];

// ২৪০ জন: এক পাতায় ৫০, তাই ড্যাশবোর্ডে scroll করলে পরের পাতাগুলো আসতে দেখা যায়
export const MEMBERS: Member[] = Array.from({ length: 240 }, (_, index) => {
  const first = FIRST[index % FIRST.length] ?? 'Abdul';
  const last = LAST[Math.floor(index / FIRST.length) % LAST.length] ?? 'Karim';
  return {
    membershipId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    fullName: `${first} ${last}`,
    email: `${first}.${last}${String(index)}@rahmangarments.com`.toLowerCase(),
    roles: ROLES[index % ROLES.length] ?? [],
  };
});
