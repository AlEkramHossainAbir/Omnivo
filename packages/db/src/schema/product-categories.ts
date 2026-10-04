import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// Product categories: a tree, like the chart of accounts but without types or codes. deleted_at is
// not used: a category is deleted for real, and only when nothing is in it (the FKs say so).
export const productCategories = pgTable(
  'product_categories',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // NULL = a top-level category
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
  },
  (table) => [
    // Two "Tablets" in one place would be two answers to "which one?". Unique among siblings, in any
    // case. COALESCE: NULLs never collide in a unique index, so without it two top-level "Fabrics"
    // would both go in; the zero uuid stands for "the top".
    uniqueIndex('product_categories_sibling_name_idx').on(
      table.tenantId,
      sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${table.name})`,
    ),
    // The target of the parent FK below and of products' category FK
    uniqueIndex('product_categories_tenant_id_idx').on(table.tenantId, table.id),
    // A category's children — and what Postgres uses to check the parent FK on delete
    index('product_categories_tenant_parent_idx').on(table.tenantId, table.parentId),
    // The parent is in the same tenant. A category with children cannot be deleted: the API turns
    // this FK's error into category_has_children.
    foreignKey({
      name: 'product_categories_parent_fk',
      columns: [table.tenantId, table.parentId],
      foreignColumns: [table.tenantId, table.id],
    }),
    check('product_categories_parent_not_self', sql`${table.parentId} <> ${table.id}`),
  ],
);
