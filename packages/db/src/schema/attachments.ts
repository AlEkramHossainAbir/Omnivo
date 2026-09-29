import { ATTACHMENT_PURPOSES } from '@omnivo/contracts';
import { integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// ফাইলের বর্ণনা — ফাইল নিজে S3/MinIO-তে। storage_key-এ ফাইলের নাম নেই ইচ্ছা করে: ইউজারের দেওয়া নাম
// ("../../x" বা বাংলা অক্ষর) পাথে বসালে পাথ ভাঙার ঝুঁকি; নাম শুধু এই টেবিলে দেখানোর জন্য
export const attachments = pgTable(
  'attachments',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    purpose: text('purpose', { enum: ATTACHMENT_PURPOSES }).notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status', { enum: ['pending', 'ready'] })
      .notNull()
      .default('pending'),
  },
  (table) => [
    uniqueIndex('attachments_storage_key_idx').on(table.storageKey),
    // tenant_settings-এর লোগোর composite FK-এর target
    uniqueIndex('attachments_tenant_id_idx').on(table.tenantId, table.id),
  ],
);
