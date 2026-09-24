import { pgTable, uuid, text, jsonb, index } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

export const auditLogs = pgTable(
  'audit_logs',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    payload: jsonb('payload'),
  },
  (table) => [index('audit_logs_tenant_idx').on(table.tenantId)],
);
