import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';

export const tenants = pgTable(
  'tenants',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    deletedAt: baseColumns().deletedAt,
    name: text('name').notNull(),
    slug: text('slug').notNull(),
  },
  (table) => [uniqueIndex('tenants_slug_idx').on(table.slug)],
);
