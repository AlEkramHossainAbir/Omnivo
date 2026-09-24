import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// append-only: omnivo_app-এর UPDATE/DELETE অধিকার migration-এ REVOKE করা,
// তাই version/updated_*/deleted_at কলামের দরকার নেই
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_logs_tenant_created_idx').on(table.tenantId, table.createdAt)],
);
