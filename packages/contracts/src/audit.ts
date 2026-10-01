import { z } from 'zod';

import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// audit log-এ যত রকম ঘটনা লেখা হয়। সার্ভার শুধু এগুলোই লিখতে পারে (টাইপ-চেকড), আর UI প্রতিটার
// লেখা i18n-এর audit.actions.*-এ রাখে (en.ts-এর satisfies নতুন action-এর অনুবাদ ভুলতে দেয় না)
export const AUDIT_ACTIONS = [
  'workspace.created',
  'workspace.setup_started',
  'workspace.provisioned',
  'workspace.chart_created',
  'auth.signed_in',
  'auth.switched_in',
  'settings.updated',
  'settings.logo_changed',
  'branch.created',
  'branch.updated',
  'branch.archived',
  'branch.restored',
  'number_series.updated',
  'member.invited',
  'member.invitation_resent',
  'member.invitation_revoked',
  'member.joined',
  'member.roles_changed',
  'member.removed',
  'role.created',
  'role.updated',
  'role.deleted',
  'role.permissions_changed',
  'account.created',
  'account.updated',
  'account.archived',
  'account.restored',
  'account.deleted',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return AUDIT_ACTIONS.some((action) => action === value);
}

// settings-এর entity = workspace নিজে (entityId = tenant id)। member = একজনের এই workspace-এর
// সদস্যপদ (entityId = membership id), user = মানুষটা নিজে (লগইন) — একই মানুষ অন্য workspace-এও থাকে
export const AUDIT_ENTITY_TYPES = [
  'workspace',
  'user',
  'branch',
  'number_series',
  'member',
  'invitation',
  'role',
  'account',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

// পুরনো আর নতুন মান শুধু সরল মান — পুরো object না। তাতে viewer-এ "নাম: X → Y" সোজা দেখানো যায়,
// আর কেউ ভুল করে গোটা রো (পাসওয়ার্ড hash সহ) audit-এ ঢুকিয়ে দিতে পারে না
export const auditValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type AuditValue = z.infer<typeof auditValueSchema>;

export const auditChangesSchema = z.record(
  z.string(),
  z.object({ from: auditValueSchema, to: auditValueSchema }),
);
export type AuditChanges = z.infer<typeof auditChangesSchema>;

export const auditEntrySchema = z.object({
  id: z.uuid(),
  // z.string(), enum না: নতুন সার্ভারের নতুন action পুরনো অফলাইন ক্লায়েন্টে parse ভাঙে না
  // (error code-এর মতোই, ধাপ ৫); UI isAuditAction() দিয়ে চেনে, অচেনা হলে কাঁচা নাম দেখায়
  action: z.string(),
  entityType: z.string(),
  entityId: z.uuid(),
  // null = the system itself: a background job in the worker (step 8)
  actor: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
  changes: auditChangesSchema,
  ipAddress: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditListQuerySchema = pageQuerySchema.extend({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  // একটা নির্দিষ্ট ব্রাঞ্চের ইতিহাস — entityType-এর সাথে
  entityId: z.uuid().optional(),
});

export const auditPageSchema = pageOf(auditEntrySchema);
export type AuditPage = z.infer<typeof auditPageSchema>;

export const auditRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/audit-logs',
    summary: 'Who changed what in the workspace, newest first',
    auth: 'bearer',
    permission: 'core.audit.read',
    status: 200,
    query: auditListQuerySchema,
    response: auditPageSchema,
  }),
};
