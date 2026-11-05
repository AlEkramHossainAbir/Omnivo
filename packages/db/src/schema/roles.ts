import { ROLE_KINDS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

export const roles = pgTable(
  'roles',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description'),
    // owner-এর অধিকার কোডে (PermissionService: owner = catalog-এর সব key), role_permissions-এ তার
    // কোনো রো নেই। custom-এর অধিকার শুধু role_permissions-এ
    kind: text('kind', { enum: ROLE_KINDS }).notNull().default('custom'),
  },
  (table) => [
    // lower(): "Accountant" আর "accountant" দুটো আলাদা রোল হলে invite-এর তালিকায় কোনটা কী বোঝা যেত না
    uniqueIndex('roles_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
    // role_permissions / membership_roles / invitation_roles-এর composite FK-এর target
    uniqueIndex('roles_tenant_id_idx').on(table.tenantId, table.id),
    // প্রতিটা workspace-এ owner রোল ঠিক একটা — কোডের "owner রোলটা খোঁজো" সবসময় একটাই রো পায়
    uniqueIndex('roles_tenant_owner_idx')
      .on(table.tenantId)
      .where(sql`${table.kind} = 'owner'`),
  ],
);
