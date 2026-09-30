import {
  INVITATION_TTL_DAYS,
  type Invitation,
  type InvitationPreview,
  type Member,
  PERMISSION_KEYS,
  type PermissionKey,
  type Role,
} from '@omnivo/contracts';

import { OWNER, type Workspace } from './fixtures';
import { MockProblem } from './mock';

// mock সার্ভারের টিম — রোল, সদস্য, invitation। নিয়মগুলো আসল API-র মতো (owner বদলানো যায় না, শেষ owner,
// নিজের রোল না, একই ইমেইলে দুটো খোলা invitation না), যাতে UI-র প্রতিটা error-পথ mock-এও দেখা যায়
export interface MockRole {
  id: string;
  name: string;
  description: string | null;
  kind: Role['kind'];
  permissions: PermissionKey[];
  version: number;
  updatedAt: string;
}

export interface MockInvitation extends Invitation {
  token: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface People {
  roles: MockRole[];
  members: Member[];
  invitations: MockInvitation[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function role(name: string, permissions: PermissionKey[], description: string | null): MockRole {
  return {
    id: crypto.randomUUID(),
    name,
    description,
    kind: 'custom',
    permissions,
    version: 1,
    updatedAt: now(),
  };
}

const FIRST = ['Abdul', 'Nasrin', 'Shafiq', 'Rupa', 'Tanvir', 'Sharmin', 'Mahbub', 'Farzana'];
const LAST = ['Karim', 'Akter', 'Islam', 'Hossain', 'Rahman', 'Chowdhury', 'Sarkar', 'Begum'];

// আসল ইন্ডাস্ট্রির রোল (CLAUDE.md → Content)। গার্মেন্টসে ২৪০ জন — এক পাতায় ৫০, তাই টিমের পেজে scroll
// করলে পরের পাতাগুলো আসতে দেখা যায়
export function seedPeople(workspace: Workspace): People {
  const owner: MockRole = {
    id: crypto.randomUUID(),
    name: 'Owner',
    description: null,
    kind: 'owner',
    permissions: [...PERMISSION_KEYS],
    version: 1,
    updatedAt: now(),
  };
  const roles = [
    owner,
    role('Accountant', ['core.user.read', 'core.audit.read'], 'Books, VAT returns and Mushak 6.3'),
    role('Merchandiser', ['core.user.read'], 'Buyer POs and LCs'),
    role('Store keeper', ['core.branch.manage'], 'Receives goods at depots and writes GRNs'),
  ];
  const custom = roles.slice(1);
  const count = workspace.slug === 'rahman-garments' ? 240 : 12;
  const members: Member[] = [
    {
      membershipId: crypto.randomUUID(),
      userId: OWNER.id,
      fullName: OWNER.fullName,
      email: OWNER.email,
      roles: [{ id: owner.id, name: owner.name }],
      version: 1,
      joinedAt: new Date(Date.now() - 400 * DAY_MS).toISOString(),
    },
    ...Array.from({ length: count }, (_, index): Member => {
      const first = FIRST[index % FIRST.length] ?? 'Abdul';
      const last = LAST[Math.floor(index / FIRST.length) % LAST.length] ?? 'Karim';
      // প্রতি পাঁচজনের একজনের কোনো রোল নেই — "No role" দেখার জন্য
      const assigned = index % 5 === 3 ? undefined : custom[index % custom.length];
      return {
        membershipId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        fullName: `${first} ${last}`,
        email: `${first}.${last}${String(index)}@${workspace.slug}.com`.toLowerCase(),
        roles: assigned ? [{ id: assigned.id, name: assigned.name }] : [],
        version: 1,
        joinedAt: new Date(Date.now() - (index + 1) * DAY_MS).toISOString(),
      };
    }),
  ];
  return { roles, members, invitations: [] };
}

export function toRole(people: People, entry: MockRole): Role {
  return {
    ...entry,
    // owner = সব key (আসল API কোড থেকে দেয়)
    permissions:
      entry.kind === 'owner' ? [...PERMISSION_KEYS].sort() : [...entry.permissions].sort(),
    memberCount: people.members.filter((member) =>
      member.roles.some((held) => held.id === entry.id),
    ).length,
  };
}

// owner আগে, তারপর নাম — আসল API-র ক্রম
export function roleList(people: People): Role[] {
  return people.roles
    .map((entry) => toRole(people, entry))
    .toSorted((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'owner' ? -1 : 1,
    );
}

export function findRole(people: People, id: string): MockRole {
  const found = people.roles.find((candidate) => candidate.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function findMember(people: People, id: string): Member {
  const found = people.members.find((candidate) => candidate.membershipId === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertRoleNameFree(people: People, name: string, except?: string): void {
  const taken = people.roles.some(
    (other) => other.id !== except && other.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new MockProblem(409, 'role_name_taken', { name: ['role_name_taken'] });
}

// mock-এ আমি সবসময় OWNER — নিজের সদস্যপদ বদলানো বন্ধ, আর owner সরালে অন্তত একজন থাকবে
export function assertCanChange(people: People, member: Member, nextRoleIds: string[]): void {
  if (member.userId === OWNER.id) throw new MockProblem(409, 'own_membership');
  const ownerRole = people.roles.find((candidate) => candidate.kind === 'owner');
  const losesOwner =
    ownerRole !== undefined &&
    member.roles.some((held) => held.id === ownerRole.id) &&
    !nextRoleIds.includes(ownerRole.id);
  const otherOwners = people.members.filter(
    (other) =>
      other.membershipId !== member.membershipId &&
      other.roles.some((held) => held.id === ownerRole?.id),
  );
  if (losesOwner && otherOwners.length === 0) throw new MockProblem(409, 'last_owner');
}

export function isOpen(invitation: MockInvitation): boolean {
  return invitation.acceptedAt === null && invitation.revokedAt === null;
}

// তারে যায় শুধু চুক্তির আকার — token আর অবস্থার ঘর বাদ
export function toInvitation(invitation: MockInvitation): Invitation {
  return {
    id: invitation.id,
    email: invitation.email,
    roles: invitation.roles,
    invitedBy: invitation.invitedBy,
    sentAt: invitation.sentAt,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    version: invitation.version,
  };
}

export function newToken(): string {
  // আসল API-র মতোই ৪৩ অক্ষরের base64url-এর মতো লম্বা, চুক্তির min(32) পেরোয়
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '').slice(0, 43);
}

export function expiry(): string {
  return new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS).toISOString();
}

// ইমেইল ছাড়াই join পেজ দেখার দুটো লিংক (`pnpm dev:mock` আর Playwright):
// /invite#<NEW> = নতুন অ্যাকাউন্ট, /invite#<EXISTING> = আগে থেকে অ্যাকাউন্ট আছে (পাসওয়ার্ড চায়)
export const DEMO_TOKENS = {
  newAccount: 'mock-new-account-invitation-token-0001',
  existingAccount: 'mock-existing-account-invitation-token-01',
} as const;

export function demoPreview(token: string, workspace: Workspace): InvitationPreview | null {
  const accountExists =
    token === DEMO_TOKENS.existingAccount ? true : token === DEMO_TOKENS.newAccount ? false : null;
  if (accountExists === null) return null;
  return {
    workspace: { name: workspace.name, slug: workspace.slug },
    email: accountExists ? 'karim@karimpharma.com' : 'tanvir@rahmangarments.com',
    invitedBy: OWNER.fullName,
    accountExists,
    expiresAt: expiry(),
  };
}
