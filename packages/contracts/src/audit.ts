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
  'device.registered',
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
  'journal.created',
  'journal.updated',
  'journal.deleted',
  'journal.posted',
  'journal.reversed',
  'journal.opening_balances_saved',
  'books.lock_date_changed',
  'books.year_closed',
  'books.year_reopened',
  'workspace.catalog_created',
  'unit.created',
  'unit.updated',
  'unit.archived',
  'unit.restored',
  'unit.deleted',
  'product_category.created',
  'product_category.updated',
  'product_category.deleted',
  'custom_field.created',
  'custom_field.updated',
  'custom_field.archived',
  'custom_field.restored',
  'product.created',
  'product.updated',
  'product.archived',
  'product.restored',
  'product.deleted',
  'product.imported',
  'warehouse.created',
  'warehouse.updated',
  'warehouse.archived',
  'warehouse.restored',
  'stock_adjustment.created',
  'stock_adjustment.updated',
  'stock_adjustment.deleted',
  'stock_adjustment.posted',
  'stock_transfer.created',
  'stock_transfer.updated',
  'stock_transfer.deleted',
  'stock_transfer.sent',
  'stock_transfer.received',
  'reorder_level.changed',
  'stock_accounts.changed',
  'stock_accounts.created',
  'stock_revaluation.posted',
  // step 15a
  'tax_rate.created',
  'tax_rate.updated',
  'tax_rate.archived',
  'tax_rate.restored',
  'tax_rates.created',
  'customer.created',
  'customer.updated',
  'customer.archived',
  'customer.restored',
  'customer.deleted',
  'customer_group.created',
  'customer_group.updated',
  'customer_group.deleted',
  'price_list.created',
  'price_list.updated',
  'price_list.archived',
  'price_list.restored',
  'price_list.prices_changed',
  // step 15b
  'quotation.created',
  'quotation.updated',
  'quotation.deleted',
  'quotation.declined',
  'quotation.reopened',
  'sales_order.created',
  'sales_order.updated',
  'sales_order.deleted',
  'sales_order.confirmed',
  'sales_order.reopened',
  'sales_order.closed',
  'sales_order.cancelled',
  'delivery.created',
  'delivery.updated',
  'delivery.deleted',
  'delivery.posted',
  // step 15c
  'invoice.created',
  'invoice.updated',
  'invoice.deleted',
  'invoice.posted',
  'receipt.created',
  'receipt.allocated',
  'receipt.voided',
  // An order confirmed or an invoice posted over the customer's credit limit, by someone with
  // sales.credit.override. The entity is that order or invoice.
  'credit_limit.overridden',
  // step 15d
  'sales_return.created',
  'sales_return.updated',
  'sales_return.deleted',
  'sales_return.posted',
  'credit_note.created',
  'credit_note.updated',
  'credit_note.deleted',
  'credit_note.posted',
  'credit_note.allocated',
  'refund.created',
  'refund.voided',
  // The sales returns account in Settings → Sales. The entity is the workspace, like settings.
  'sales_accounts.changed',
  // step 17a
  'supplier.created',
  'supplier.updated',
  'supplier.archived',
  'supplier.restored',
  'supplier.deleted',
  'supplier_group.created',
  'supplier_group.updated',
  'supplier_group.deleted',
  // The approval levels of one kind of document, in Settings → Approvals. The entity is the
  // workspace, like settings.
  'approval_rules.changed',
  'requisition.created',
  'requisition.updated',
  'requisition.deleted',
  'requisition.cancelled',
  // step 17b
  'requisition.closed',
  'purchase_order.created',
  'purchase_order.updated',
  'purchase_order.deleted',
  'purchase_order.closed',
  'purchase_order.cancelled',
  'goods_receipt.created',
  'goods_receipt.updated',
  'goods_receipt.deleted',
  'goods_receipt.posted',
  // step 17c. A bill and a payment are posted by their last approval (or at once with no level),
  // so ".posted" follows "approval.approved" or "approval.submitted" in their history.
  'bill.created',
  'bill.updated',
  'bill.deleted',
  'bill.posted',
  'bill.cancelled',
  'supplier_payment.created',
  'supplier_payment.updated',
  'supplier_payment.deleted',
  'supplier_payment.posted',
  'supplier_payment.cancelled',
  'supplier_payment.allocated',
  'supplier_payment.voided',
  // The price difference and purchased services accounts in Settings → Purchase. The entity is the
  // workspace, like settings.
  'purchase_accounts.changed',
  // step 17d. None of the three needs an approval.
  'purchase_return.created',
  'purchase_return.updated',
  'purchase_return.deleted',
  'purchase_return.posted',
  'debit_note.created',
  'debit_note.updated',
  'debit_note.deleted',
  'debit_note.posted',
  'debit_note.allocated',
  'supplier_refund.created',
  'supplier_refund.voided',
  // The approval steps of any document that needs one. The entity is that document (a requisition,
  // a purchase order; a bill and a payment from 17c), so its history reads in one place.
  'approval.submitted',
  'approval.approved',
  'approval.rejected',
  'approval.reopened',
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
  'journal_entry',
  'unit',
  'product_category',
  'custom_field',
  'product',
  'product_import',
  'warehouse',
  'stock_adjustment',
  'stock_transfer',
  'reorder_level',
  'stock_revaluation',
  'tax_rate',
  'customer',
  'customer_group',
  'price_list',
  'quotation',
  'sales_order',
  'delivery',
  'invoice',
  'receipt',
  'sales_return',
  'credit_note',
  'refund',
  'supplier',
  'supplier_group',
  'requisition',
  'purchase_order',
  'goods_receipt',
  'bill',
  'supplier_payment',
  'purchase_return',
  'debit_note',
  'supplier_refund',
  'device',
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
