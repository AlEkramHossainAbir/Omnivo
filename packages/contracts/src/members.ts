import { z } from 'zod';

import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// রোলের নাম আর id দুটোই: তালিকায় নাম দেখায়, আর সদস্যের রোল বদলানোর ফর্ম id দিয়ে টিক বসায়
export const roleRefSchema = z.object({ id: z.uuid(), name: z.string() });
export type RoleRef = z.infer<typeof roleRefSchema>;

export const memberSchema = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  roles: z.array(roleRefSchema),
  // সদস্যপদের version — দুজন একসাথে একই সদস্যের রোল বদলালে দ্বিতীয়জন 409 পায়
  version: z.number().int(),
  joinedAt: z.iso.datetime(),
});
export type Member = z.infer<typeof memberSchema>;

// সার্ভার যেভাবে সাজাতে পারে শুধু সেগুলো — "-" মানে উল্টো ক্রম (JSON:API-র প্রচলিত রূপ)
export const MEMBER_SORTS = ['name', '-name'] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];

export const memberListQuerySchema = pageQuerySchema.extend({
  sort: z.enum(MEMBER_SORTS).default('name'),
});

export const memberPageSchema = pageOf(memberSchema);
export type MemberPage = z.infer<typeof memberPageSchema>;

// রোলের পুরো নতুন তালিকা। ফাঁকা চলে — তখন সদস্য লগইন করতে পারে কিন্তু কিছুই করতে পারে না (যেমন কেউ
// ছুটিতে গেলে অধিকার তুলে রাখা, সদস্যপদ না মুছে)। max: একজনের দশটার বেশি রোল মানে রোলের নকশা ভুল
export const memberRolesInputSchema = z.object({
  roleIds: z.array(z.uuid()).max(10),
  version: versionSchema,
});
export type MemberRolesInput = z.infer<typeof memberRolesInputSchema>;

export const removeMemberQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

const memberParamsSchema = z.object({ id: z.uuid() });

export const memberRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/members',
    summary: 'People with access to the active workspace, one page at a time',
    auth: 'bearer',
    permission: 'core.user.read',
    status: 200,
    query: memberListQuerySchema,
    response: memberPageSchema,
  }),
  updateRoles: defineRoute({
    method: 'PUT',
    path: '/members/:id/roles',
    summary: "Replace a member's roles",
    auth: 'bearer',
    permission: 'core.user.manage',
    status: 200,
    params: memberParamsSchema,
    body: memberRolesInputSchema,
    response: memberSchema,
  }),
  // সদস্যপদ মোছা হয় না, বন্ধ হয় (deleted_at) — তার আগের কাজের audit আর created_by অক্ষত থাকে,
  // আর আবার invite করলে একই সদস্যপদ ফিরে আসে
  remove: defineRoute({
    method: 'DELETE',
    path: '/members/:id',
    summary: 'Remove someone from the workspace; their account stays',
    auth: 'bearer',
    permission: 'core.user.manage',
    status: 204,
    params: memberParamsSchema,
    query: removeMemberQuerySchema,
    response: z.void(),
  }),
};
