import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';

// permissions tenant-scoped নয় — এটা সিস্টেম-জোড়া ফিক্সড তালিকা (যেমন 'core.user.invite')
export const permissions = pgTable(
  'permissions',
  {
    ...baseColumns(),
    key: text('key').notNull(),
    description: text('description').notNull(),
  },
  (table) => [uniqueIndex('permissions_key_idx').on(table.key)],
);
