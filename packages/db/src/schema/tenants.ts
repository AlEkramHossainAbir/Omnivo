import { INDUSTRIES, SETUP_STATUSES } from '@omnivo/contracts';
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
    // Picked once in the onboarding wizard; NULL until then. It chooses the starting template.
    industry: text('industry', { enum: INDUSTRIES }),
    // The tenant lifecycle's first stage (system-design §4.7). Here, not in tenant_settings:
    // settings is the company profile the owner edits; this is state the system moves forward.
    setupStatus: text('setup_status', { enum: SETUP_STATUSES }).notNull().default('pending'),
  },
  (table) => [uniqueIndex('tenants_slug_idx').on(table.slug)],
);
