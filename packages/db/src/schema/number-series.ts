import { DOCUMENT_TYPES, YEAR_STYLES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// টেন্যান্ট নিজের মতো বদলালে তবেই রো — না থাকলে contracts-এর defaultNumberFormat()। তাই নতুন
// ডকুমেন্ট টাইপ যোগ করলে পুরনো সব টেন্যান্টের জন্য backfill migration লাগে না
export const numberSeries = pgTable(
  'number_series',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentType: text('document_type', { enum: DOCUMENT_TYPES }).notNull(),
    prefix: text('prefix').notNull(),
    yearStyle: text('year_style', { enum: YEAR_STYLES }).notNull(),
    padding: smallint('padding').notNull(),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
  },
  (table) => [
    uniqueIndex('number_series_tenant_type_idx').on(table.tenantId, table.documentType),
    check('number_series_padding_check', sql`${table.padding} BETWEEN 3 AND 8`),
  ],
);

// কোন সময়কালে শেষ কোন নম্বর দেওয়া হয়েছে। Postgres SEQUENCE না, কারণ sequence rollback মানে না:
// ইনভয়েস সেভ ব্যর্থ হলেও নম্বর খরচ হয়ে যেত, আর VAT অডিটে INV-0041-এর পরে INV-0043 মানে
// "০০৪২ কোথায়?" প্রশ্ন। এই রো একই transaction-এ বাড়ে, তাই rollback হলে নম্বরও ফেরত আসে
export const numberSeriesCounters = pgTable(
  'number_series_counters',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentType: text('document_type', { enum: DOCUMENT_TYPES }).notNull(),
    // periodOf()-এর মান ('2026-27', '2026'); বছর ছাড়া ছাঁচে 'all'
    period: text('period').notNull(),
    // mode 'number': ২^৫৩ পর্যন্ত নির্ভুল — এক টেন্যান্টের এক বছরের ইনভয়েস তার ধারেকাছেও যাবে না
    lastValue: bigint('last_value', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.documentType, table.period] })],
);
