import type { AuditAction, AuditChanges, AuditEntityType } from '@omnivo/contracts';
import { pgTable, uuid, text, jsonb, timestamp, index, inet } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// JSON-এ কী থাকে: বদলানো ফিল্ডগুলোর পুরনো আর নতুন মান (সরল মান, পুরো রো না)
export interface AuditPayload {
  changes: AuditChanges;
}

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
    // $type: DB-তে সাধারণ text (পুরনো রো-র action পরে নাম বদলালেও টিকে থাকে), কিন্তু কোড শুধু
    // contracts-এর তালিকার মান লিখতে পারে
    action: text('action').$type<AuditAction>().notNull(),
    entityType: text('entity_type').$type<AuditEntityType>().notNull(),
    entityId: uuid('entity_id').notNull(),
    payload: jsonb('payload').$type<AuditPayload>(),
    // কোন request থেকে — সাপোর্টে "এই বদলটা কোন ডিভাইস থেকে?" প্রশ্নের উত্তর, আর error লগের সাথে মেলানো
    requestId: text('request_id'),
    // inet: Postgres নিজেই IP-র আকার যাচাই করে, আর পরে "এই subnet থেকে" খোঁজা যায়
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // viewer: নতুন আগে, keyset (created_at, id) — id একই মুহূর্তের রো-গুলোর টাই ভাঙে
    index('audit_logs_tenant_created_id_idx').on(table.tenantId, table.createdAt, table.id),
    // একটা জিনিসের ইতিহাস ("এই ব্রাঞ্চে কে কী বদলাল")
    index('audit_logs_tenant_entity_idx').on(
      table.tenantId,
      table.entityType,
      table.entityId,
      table.createdAt,
      table.id,
    ),
  ],
);
