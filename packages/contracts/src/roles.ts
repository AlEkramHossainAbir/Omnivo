import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { PERMISSION_KEYS } from './permissions.js';

// owner = প্রতিটা workspace-এ ঠিক একটা, signup-এ তৈরি। তার অধিকার কোডে লেখা ("সব permission"),
// ডেটায় না — তাই নতুন permission এলে কোনো backfill লাগে না, আর নাম, permission বা মোছা বদলানো যায় না।
// custom = workspace নিজে বানায়, matrix-এ যা টিক দেওয়া ঠিক ততটুকু
export const ROLE_KINDS = ['owner', 'custom'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const roleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(ROLE_KINDS),
  // z.string(), enum না: নতুন সার্ভারের নতুন permission পুরনো অফলাইন ক্লায়েন্টে parse ভাঙে না
  // (audit action-এর মতোই); UI isPermissionKey() দিয়ে চেনে। owner-এর ক্ষেত্রে এখন চালু সব key
  permissions: z.array(z.string()),
  // কতজন সদস্যের এই রোল — মোছার আগে UI জানায়, আর matrix-এর কলামের নিচে দেখায়
  memberCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Role = z.infer<typeof roleSchema>;

// ছোট তালিকা (একটা কোম্পানিতে কয়েকটা রোল) — ব্রাঞ্চের মতো একবারে, পাতা ছাড়া (ধাপ ৬-এর নিয়ম)
export const roleListSchema = z.object({ items: z.array(roleSchema) });

export const roleInputSchema = z.object({
  name: z.string().trim().min(2, errorCode('role_name_required')).max(60),
  description: optionalText(200),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

export const updateRoleInputSchema = roleInputSchema.extend({ version: versionSchema });

// DELETE-এর body অনেক proxy ফেলে দেয় — তাই version query-তে। querystring-এ সব string, তাই coerce
export const deleteRoleQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// matrix একসাথে সেভ: যতগুলো রোলের টিক বদলেছে, সবগুলো এক transaction-এ — অর্ধেক সেভ হয়ে বাকিটা
// version_conflict-এ আটকে থাকার অবস্থা নেই। প্রতিটার পুরো নতুন তালিকা (যোগ/বাদ আলাদা না): সার্ভার
// নিজেই আগের সাথে মিলিয়ে বদলটা বের করে, আর audit-এ শুধু সেটুকু লেখে
export const permissionMatrixInputSchema = z.object({
  roles: z
    .array(
      z.object({
        id: z.uuid(),
        version: versionSchema,
        permissions: z.array(z.enum(PERMISSION_KEYS)).max(PERMISSION_KEYS.length),
      }),
    )
    .min(1)
    .max(50),
});
export type PermissionMatrixInput = z.infer<typeof permissionMatrixInputSchema>;

const roleParamsSchema = z.object({ id: z.uuid() });

export const roleRoutes = {
  // পড়তে শুধু সদস্য হলেই চলে: invite আর সদস্যের রোল বদলানোর ফর্মে রোলের তালিকা লাগে, আর কোন রোল কী
  // পারে সেটা কোম্পানির ভেতরে গোপন কিছু না (ব্রাঞ্চের তালিকার মতো)
  list: defineRoute({
    method: 'GET',
    path: '/roles',
    summary: 'Roles of the active workspace, with their permissions',
    auth: 'bearer',
    status: 200,
    response: roleListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/roles',
    summary: 'Create a custom role, with no permissions yet',
    auth: 'bearer',
    permission: 'core.role.manage',
    status: 201,
    body: roleInputSchema,
    response: roleSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/roles/:id',
    summary: 'Rename a custom role or change its description',
    auth: 'bearer',
    permission: 'core.role.manage',
    status: 200,
    params: roleParamsSchema,
    body: updateRoleInputSchema,
    response: roleSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/roles/:id',
    summary: 'Delete a custom role that nobody has and no open invitation uses',
    auth: 'bearer',
    permission: 'core.role.manage',
    status: 204,
    params: roleParamsSchema,
    query: deleteRoleQuerySchema,
    response: z.void(),
  }),
  // build-plan-এর "permission matrix API": রোল × permission-এর ছক একবারে
  updateMatrix: defineRoute({
    method: 'PUT',
    path: '/permission-matrix',
    summary: 'Save the permissions of several roles at once',
    auth: 'bearer',
    permission: 'core.role.manage',
    status: 200,
    body: permissionMatrixInputSchema,
    response: roleListSchema,
  }),
};
