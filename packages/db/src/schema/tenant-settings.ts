import { CURRENCIES, DEFAULT_SETTINGS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { attachments } from './attachments.js';
import { tenants } from './tenants.js';

// প্রতি টেন্যান্টে ঠিক একটা রো, তাই tenant_id নিজেই primary key — আলাদা id লাগে না, আর "একটার বেশি
// settings রো" অবস্থা DB-লেভেলেই অসম্ভব। কোম্পানির নাম এখানে না: সেটা tenants.name-এ, কারণ লগইন আর
// workspace switcher সেটা tenant context ছাড়াই পড়ে
export const tenantSettings = pgTable(
  'tenant_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    legalName: text('legal_name'),
    bin: text('bin'),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    baseCurrency: text('base_currency', { enum: CURRENCIES })
      .notNull()
      .default(DEFAULT_SETTINGS.baseCurrency),
    fiscalYearStartMonth: smallint('fiscal_year_start_month')
      .notNull()
      .default(DEFAULT_SETTINGS.fiscalYearStartMonth),
    timezone: text('timezone').notNull().default(DEFAULT_SETTINGS.timezone),
    logoAttachmentId: uuid('logo_attachment_id'),
    // Step 13: may an untracked product's stock go below zero? Read by migration 0022's trigger.
    allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
  },
  (table) => [
    check(
      'tenant_settings_fiscal_month_check',
      sql`${table.fiscalYearStartMonth} BETWEEN 1 AND 12`,
    ),
    // composite FK: লোগো হিসেবে অন্য টেন্যান্টের ফাইল বসানো DB-লেভেলেই অসম্ভব। NULL হলে চেক হয় না
    foreignKey({
      name: 'tenant_settings_logo_fk',
      columns: [table.tenantId, table.logoAttachmentId],
      foreignColumns: [attachments.tenantId, attachments.id],
    }),
  ],
);
