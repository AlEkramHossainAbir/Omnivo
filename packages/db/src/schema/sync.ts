import type { SyncEntity } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { branches } from './branches.js';
import { memberships } from './memberships.js';
import { tenants } from './tenants.js';

// Postgres's 64-bit transaction id (xid8). It never wraps around, unlike the old 32-bit xid, so
// two of them always compare in the order the transactions started. A string in TypeScript: the
// value may pass 2^53, and only the database compares them.
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

// The change log of step 18a: one row for every row of a synced table that was written, written
// by migration 0044's triggers in the same transaction. Code never writes it. The pull reads the
// keys a device has not seen yet and sends each one in its current state (or as a delete when it
// is gone or no longer the device's), so a row says only WHICH thing changed, never what changed.
// A key is often here many times; the pull sends it once.
export const syncChanges = pgTable(
  'sync_changes',
  {
    // The order inside one transaction. Never a cursor on its own (see xid).
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // $type, no check: like the outbox's type, an old row survives an entity a later protocol
    // drops, and the pull skips what it does not know
    entity: text('entity').$type<SyncEntity>().notNull(),
    // The contract's key: the row's id, priceListItemKey() or stockKey(); the settings' key is the
    // tenant id. The triggers build exactly those strings.
    entityKey: text('entity_key').notNull(),
    // A stock row's warehouse, NULL for every other entity. A device keeps the stock of its
    // branch only, so its pull skips the other branches' stock here, without reading the rows.
    warehouseId: uuid('warehouse_id'),
    // The transaction that wrote the change. The pull's cursor is a watermark on it (decision 25):
    // it reads only the transactions that finished before the oldest one still running.
    xid: xid8('xid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    // For pruning only (the log keeps 30 days, decision 26). The pull never reads it.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The pull: a tenant's changes from the cursor on, in order
    index('sync_changes_tenant_xid_idx').on(table.tenantId, table.xid, table.id),
    // The worker's pruning: the oldest rows of every tenant
    index('sync_changes_created_idx').on(table.createdAt),
  ],
);

// A device (decision 7): one browser profile, for one person in one workspace, in one branch. The
// browser makes the id (a UUIDv7) and keeps it, so a registration whose answer was lost registers
// the same device again. Step 18c lists, renames, moves and revokes them.
// deleted_at (from baseColumns) is not used: a device is revoked, never deleted, because its
// commands (step 18b) point at it.
export const devices = pgTable(
  'devices',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    branchId: uuid('branch_id').notNull(),
    // When it last finished a pull, by the server's clock. The pull writes only this column, never
    // version or updated_at: a pull a minute must not make step 18c's rename fail on its version.
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // A person's devices (step 18c's list) — and Postgres's own check of the membership FK
    index('devices_tenant_user_idx').on(table.tenantId, table.userId),
    // The devices of a branch, and the branch FK's own check
    index('devices_tenant_branch_idx').on(table.tenantId, table.branchId),
    // A device is a member's of THIS workspace. Members are removed with deleted_at, never
    // deleted, so the FK never stops a removal.
    foreignKey({
      name: 'devices_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    foreignKey({
      name: 'devices_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
  ],
);
