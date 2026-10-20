import { PERMISSION_KEYS, type PermissionKey } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { permissions } from './schema/index.js';

// key-এর তালিকা contracts-এ (API, UI, অনুবাদ সবাই সেখান থেকে); এখানে শুধু DB-র permissions টেবিলের
// ইংরেজি বিবরণ — psql বা Drizzle Studio-তে দেখার জন্য। satisfies: নতুন key-র বিবরণ ভুলে গেলে compile error
const DESCRIPTIONS = {
  'core.user.read': 'View people in the workspace',
  'core.user.invite': 'Invite people and manage open invitations',
  'core.user.manage': "Change members' roles and remove members",
  'core.role.manage': 'Create roles and choose their permissions',
  'core.settings.manage': 'Edit the company profile, regional settings and numbering',
  'core.branch.manage': 'Add, edit and archive branches',
  'core.audit.read': 'View the audit log',
  'accounting.account.manage':
    'Add, edit, move, archive and delete accounts in the chart of accounts',
  'accounting.journal.read': 'View journal entries, ledgers and opening balances',
  'accounting.journal.create': 'Write, edit and delete draft journal entries',
  'accounting.journal.post': 'Post and reverse journal entries, and set the opening balances',
  'accounting.period.close':
    'Close the books up to a date, close and reopen fiscal years, and open the books again',
  'accounting.report.read':
    'View the trial balance, profit and loss and balance sheet, and export them to Excel or PDF',
  'inventory.product.manage':
    'Add, edit, archive and import products, manage their categories and units, and set reorder levels',
  'inventory.warehouse.manage': 'Add, edit and archive warehouses',
  'inventory.stock.adjust': 'Write and post stock adjustments, including opening stock',
  'inventory.stock.transfer': 'Send stock to another warehouse and receive it there',
  'inventory.stock.value': 'See what stock costs and what it is worth',
  'inventory.stock.revalue': 'Revalue stock: give items a new average cost',
  'sales.customer.manage': 'Add, edit, archive and delete customers and customer groups',
  'sales.customer.balance': 'See what customers owe, and their statements',
  'sales.price_list.manage': 'Add, edit and archive price lists, and set their prices',
  'sales.quotation.manage': 'Write, edit, decline and delete quotations',
  'sales.order.manage': 'Write, confirm, reopen, close and cancel sales orders',
  'sales.delivery.manage': 'Write and post deliveries (delivery challans), which take stock out',
  'sales.invoice.manage': 'Write, post and delete draft sales invoices',
  'sales.receipt.manage': 'Record money receipts, apply them to invoices and void them',
  'sales.credit.override': "Confirm orders and post invoices over a customer's credit limit",
  'sales.return.manage': 'Write and post sales returns, which bring stock back in',
  'sales.credit_note.manage': 'Write and post credit notes, and apply their money to invoices',
  'sales.refund.manage': 'Pay money back to customers and void refunds',
  'purchase.supplier.manage': 'Add, edit, archive and delete suppliers and supplier groups',
  'purchase.supplier.balance': 'See what the company owes suppliers, and their statements',
  'purchase.requisition.manage':
    'Write, submit, reopen, close, cancel and delete purchase requisitions',
  'purchase.order.manage': 'Write, submit, reopen, close, cancel and send purchase orders',
  'purchase.receipt.manage': 'Write and post goods receipts, which bring stock in',
  'purchase.bill.manage': 'Write, submit, reopen and cancel supplier bills',
  'purchase.payment.manage': 'Write, submit, apply and void supplier payments',
  'purchase.return.manage': 'Write and post purchase returns, which send stock back to suppliers',
  'purchase.debit_note.manage': 'Write and post debit notes, and apply their money to bills',
  'purchase.refund.manage': 'Record money suppliers paid back, and void supplier refunds',
} satisfies Record<PermissionKey, string>;

export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));

// signup-এ তৈরি owner রোলের নাম। নামটা শুধু দেখানোর — কোড owner চেনে roles.kind দিয়ে, নাম দিয়ে না
export const OWNER_ROLE_NAME = 'Owner';

// Pick<..., 'insert'>: migrate-এর plain db, createDb()-এর Db, বা transaction-এর tx — সবই চলে
// idempotent: নতুন key যোগ হয়, পুরনো key-এর description আপডেট হয়; কিছু মোছে না
export async function syncPermissions(db: Pick<PostgresJsDatabase, 'insert'>): Promise<void> {
  await db
    .insert(permissions)
    .values(PERMISSIONS)
    .onConflictDoUpdate({
      target: permissions.key,
      set: { description: sql`excluded.description` },
    });
}
