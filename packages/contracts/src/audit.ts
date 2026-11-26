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
  'device.renamed',
  'device.moved',
  'device.revoked',
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
  // step 20a. claimed/released: a device took the register or let it go (the changes name the
  // device). A sale arrives from a device, so its rows name the device too (step 18b).
  // pos_sale.overridden: what the cashier did that needs pos.price.override (posOverridesOf),
  // written whether or not the cashier had it. The sale is never refused for it.
  // pos_sale.without_permission: the cashier no longer had pos.sale.create when the sale arrived
  // (it was taken away while the device was offline). The sale is posted anyway (decision 28).
  'pos_register.created',
  'pos_register.updated',
  'pos_register.archived',
  'pos_register.restored',
  'pos_register.claimed',
  'pos_register.released',
  'pos_sale.created',
  'pos_sale.overridden',
  'pos_sale.without_permission',
  // step 20b. A shift's rows name its device like a sale's. cash_moved: a pay in or pay out (the
  // changes name the reason and the amount). closed_without_count: by a manager online, or by the
  // revoke of its device. expected_differs: the device's expected cash at the close was not the
  // server's (a sale or a movement missing on one side). without_permission: like a sale's, for
  // any of the three commands.
  'pos_cash_reason.created',
  'pos_cash_reason.updated',
  'pos_cash_reason.archived',
  'pos_cash_reason.restored',
  'pos_shift.opened',
  'pos_shift.cash_moved',
  'pos_shift.closed',
  'pos_shift.closed_without_count',
  'pos_shift.expected_differs',
  'pos_shift.without_permission',
  // step 20c. A return's rows name its device like a sale's. The server takes every return, and
  // writes what it would have refused: outside_window (after the register's window),
  // over_returned (more of a line than was left: another counter took some back first),
  // amounts_differ (the device's money back was not the server's arithmetic, for the same reason),
  // without_permission (the cashier no longer had pos.return.create).
  'pos_return.created',
  'pos_return.outside_window',
  'pos_return.over_returned',
  'pos_return.amounts_differ',
  'pos_return.without_permission',
  // Step 21c: a report sent by email on a schedule. paused with no actor: the worker found that
  // nobody on it may read the report any more (the changes say why).
  'report_schedule.created',
  'report_schedule.updated',
  'report_schedule.paused',
  'report_schedule.resumed',
  'report_schedule.deleted',
  // Step 26g: the shop (entity = the workspace's storefront, entityId = tenant id), its categories
  // and its listings. A photo upload is not an event of its own: the listing's save that uses it is
  'storefront.created',
  'storefront.updated',
  'storefront.launched',
  'storefront_category.created',
  'storefront_category.updated',
  'storefront_category.moved',
  'storefront_category.deleted',
  'storefront_listing.created',
  'storefront_listing.updated',
  'storefront_listing.published',
  'storefront_listing.unpublished',
  'storefront_listing.deleted',
  // Step 26h. The logo and colors, the home page's order and the text pages belong to the shop
  // itself (entity = storefront, entityId = tenant id; a page's slug is in the changes): a page
  // has no id of its own. The hero is a banner (its changes say kind: hero)
  'storefront.theme_updated',
  'storefront.home_moved',
  'storefront.page_saved',
  'storefront.page_deleted',
  'storefront_banner.created',
  'storefront_banner.updated',
  'storefront_banner.deleted',
  'storefront_collection.created',
  'storefront_collection.updated',
  'storefront_collection.deleted',
  // Step 27b: a shop order's moves in the ERP (entity = storefront_order). The documents a move
  // makes (sales order, challan, invoice, sales return) write their own entries as well, with the
  // order's number in their changes. sales_order_made is the retry; the one made at confirm has
  // no member, so the worker writes it with no actor
  'storefront_order.sales_order_made',
  'storefront_order.packed',
  'storefront_order.shipped',
  'storefront_order.delivered',
  'storefront_order.cancelled',
  // Step 27c: the shop's coupons (entity = storefront_coupon). An order that uses one writes
  // nothing here: the order itself keeps the code and the discount
  'storefront_coupon.created',
  'storefront_coupon.updated',
  'storefront_coupon.archived',
  'storefront_coupon.restored',
  // Step 27d: the shop's payment gateway account (entity = storefront_payment_gateway, entityId =
  // the tenant's id: a workspace has one). The password is never in the changes, only that it
  // changed. A payment writes nothing here: the money receipt it makes writes its own entry, with
  // the order's number in its changes
  'storefront_payment_gateway.created',
  'storefront_payment_gateway.updated',
  'storefront_payment_gateway.tested',
  // Step 28a: the shop's courier accounts (entity = courier_account). Keys and tokens are never in
  // the changes, only that they changed. The default is the workspace's storefront's change
  // (entity = storefront, entityId = tenant id). A booking is the order's: booked by a member
  // (with the account's name and, for a manual parcel, the tracking code) and booked again after
  // it failed. What the courier reports later writes nothing here: it is on the parcel's events
  'courier_account.created',
  'courier_account.updated',
  'courier_account.tested',
  'courier_account.token_renewed',
  'courier_account.archived',
  'courier_account.restored',
  'storefront.default_courier_set',
  'storefront_order.shipment_booked',
  'storefront_order.shipment_retried',
  // Step 28b: the order's two ends after the courier: partly delivered (with what came back, the
  // collected amount and the documents) and returned (Receive the return, with the reason). The
  // COD receipt writes its own receipt entry; cod_receipt_made is the member's retry of a failed one
  'storefront_order.partly_delivered',
  'storefront_order.returned',
  'storefront_order.cod_receipt_made',
  // Step 28c: the courier's payout (entity = storefront_payout), made (with its number, account,
  // bank account, parcel count and the three sums) and voided (with the date and the reason). A
  // saved CSV map writes nothing here: it changes no money and no document
  'storefront_payout.created',
  'storefront_payout.voided',
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
  'pos_register',
  'pos_sale',
  'pos_cash_reason',
  'pos_shift',
  'pos_return',
  'report_schedule',
  'storefront',
  'storefront_category',
  'storefront_listing',
  'storefront_banner',
  'storefront_collection',
  'storefront_order',
  'storefront_coupon',
  'storefront_payment_gateway',
  'courier_account',
  'storefront_payout',
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
  // The device the change was made on without a connection (step 18b), sent later in a sync
  // command; null for a change made online
  device: z.object({ id: z.uuid(), name: z.string() }).nullable(),
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
