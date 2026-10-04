import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// A workspace's own fields (system-design §4.8): what each one is called and what it holds. The
// values live on the records themselves, in a custom_fields JSONB column under `key`.
export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    entity: text('entity', { enum: CUSTOM_FIELD_ENTITIES }).notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type', { enum: CUSTOM_FIELD_TYPES }).notNull(),
    // A select's choices; empty for the other types
    options: text('options')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    required: boolean('required').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // One key per kind of record: it is the JSON key the values are saved under
    uniqueIndex('custom_field_definitions_key_idx').on(table.tenantId, table.entity, table.key),
    check(
      'custom_field_definitions_select_check',
      sql`${table.type} <> 'select' OR cardinality(${table.options}) > 0`,
    ),
  ],
);
