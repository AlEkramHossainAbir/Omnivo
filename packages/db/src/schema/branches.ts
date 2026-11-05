import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

export const branches = pgTable(
  'branches',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    address: text('address'),
    // deleted_at না, archived_at: পরে ইনভয়েস আর স্টক ব্রাঞ্চকে রেফার করবে, তাই মোছা যায় না —
    // শুধু নতুন কাজে আর দেখানো হয় না। deleted_at (baseColumns-এর) এই টেবিলে ব্যবহার হয় না
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // archive করা ব্রাঞ্চের কোডও ধরা থাকে — পুরনো রিপোর্টে "GZP" যেন দুটো আলাদা ব্রাঞ্চ না বোঝায়
    uniqueIndex('branches_tenant_code_idx').on(table.tenantId, table.code),
    // পরের ধাপের composite FK-এর target (ইনভয়েস → একই টেন্যান্টের ব্রাঞ্চ)
    uniqueIndex('branches_tenant_id_idx').on(table.tenantId, table.id),
  ],
);
