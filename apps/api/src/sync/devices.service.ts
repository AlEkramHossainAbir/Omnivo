import { Inject, Injectable } from '@nestjs/common';
import type {
  Device,
  DeviceKey,
  DeviceListItem,
  DevicePage,
  DeviceSort,
  DeviceStatus,
  MoveDeviceInput,
  MyDeviceList,
  RegisterDeviceInput,
  RenameDeviceInput,
} from '@omnivo/contracts';
import { branches, devices, users } from '@omnivo/db';
import { and, asc, desc, eq, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { containsPattern } from '../common/db/search.js';
import { AppError, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type Access, PermissionService } from '../rbac/permission.service.js';
import { revokeDevices } from './device-revoke.js';

export type DeviceRow = typeof devices.$inferSelect;

// What an answer shows of a device. Step 19b: never its key.
type DeviceFields = Pick<
  DeviceRow,
  'id' | 'name' | 'branchId' | 'userId' | 'lastSyncAt' | 'revokedAt' | 'createdAt' | 'version'
>;

function toDevice(row: DeviceFields): Device {
  return {
    id: row.id,
    name: row.name,
    branchId: row.branchId,
    userId: row.userId,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

// Another person's device, an unknown id and (through RLS) another workspace's device all answer
// the same: nobody learns that an id exists somewhere else. The app registers the browser again.
function deviceNotFound(): AppError {
  return new AppError(404, 'device_not_found', 'This device is not registered. Register it again.');
}

function deviceRevoked(): AppError {
  return new AppError(403, 'device_revoked', 'This device was revoked. Its data is wiped.');
}

// Step 18c: the person who revoked a device, next to the person it belongs to (both in users)
const revoker = alias(users, 'revoker');

// Step 19b: a list reads only the columns it shows, never the key, so a page of 50 devices does
// not carry 50 keys out of the database. Named one by one, so a column added later stays out of
// the lists until someone adds it here.
const deviceColumns = {
  id: devices.id,
  name: devices.name,
  branchId: devices.branchId,
  userId: devices.userId,
  lastSyncAt: devices.lastSyncAt,
  revokedAt: devices.revokedAt,
  createdAt: devices.createdAt,
  version: devices.version,
} satisfies { [K in keyof DeviceFields]: (typeof devices)[K] };

const listColumns = {
  device: deviceColumns,
  // users, not memberships: the name stays after the person left the workspace (decision 7)
  userName: users.fullName,
  branchName: branches.name,
  revokedByName: revoker.fullName,
};

interface ListRow {
  device: DeviceFields;
  userName: string;
  branchName: string;
  revokedByName: string | null;
}

function toListItem(row: ListRow): DeviceListItem {
  return {
    ...toDevice(row.device),
    userName: row.userName,
    branchName: row.branchName,
    revokedByName: row.revokedByName,
  };
}

// The sort key of 'lastSync': the time in microseconds, the database's own precision. A JS Date
// has milliseconds only, so a cursor made from one would skip or repeat devices that synced in
// the same millisecond. A device that never synced is -1, before every real time: first in
// 'lastSync' (decision 8), last in '-lastSync'. One expression in ORDER BY and in the cursor's
// comparison, so the two can never disagree.
const syncKey = sql`coalesce((extract(epoch from ${devices.lastSyncAt}) * 1000000)::bigint, -1)`;

function isSyncSort(sort: DeviceSort): boolean {
  return sort === 'lastSync' || sort === '-lastSync';
}

@Injectable()
export class DevicesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  // Decision 20: the browser makes the id, so registering is safe to repeat. The same id by the
  // same person returns the device as it is, even when the name or the branch sent differ (a
  // retry of a lost answer sends the same ones; changing them is step 18c's rename and move).
  register(input: RegisterDeviceInput): Promise<Device> {
    return this.withTenant(async (tx) => {
      const known = await this.ownedOrNone(tx, input.id);
      if (known) {
        // Step 18c: signed in again on the same browser (a new session), the device follows it.
        // A revoked one is returned as it is: the app wipes it and makes a new id (decision 4).
        await this.keepSession(tx, known);
        return toDevice(known);
      }

      const branch = await this.activeBranchCode(tx, input.branchId);
      const { userId, sessionId } = currentPrincipal();
      const [row] = await tx
        .insert(devices)
        .values({
          id: input.id,
          tenantId: getTenantId(),
          userId,
          name: input.name,
          branchId: input.branchId,
          sessionId,
          createdBy: userId,
        })
        // Two registrations of the same id at once (the app retried while the first was still
        // running): the second waits for the first to commit, inserts nothing, and reads the row
        // below. Also an id taken in another workspace: the primary key is global, RLS is not.
        .onConflictDoNothing({ target: devices.id })
        .returning();
      if (!row) {
        const raced = await this.ownedOrNone(tx, input.id);
        if (raced) return toDevice(raced);
        throw new AppError(409, 'device_id_invalid', 'Make a new id for this device.');
      }
      await audit(tx, {
        action: 'device.registered',
        entityType: 'device',
        entityId: row.id,
        changes: created({ name: row.name, branch }),
      });
      return toDevice(row);
    });
  }

  // The pull's and the push's check, inside a transaction: the device is this person's, and not
  // revoked
  async forSync(tx: Transaction, id: string): Promise<DeviceRow> {
    const [row] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)));
    if (row?.userId !== currentPrincipal().userId) throw deviceNotFound();
    if (row.revokedAt !== null) throw deviceRevoked();
    return row;
  }

  // Step 19b: the device's key, to its own person while it is active (forSync's check). FOR
  // SHARE: a revoke running now holds the row FOR UPDATE, so this waits for its commit, reads the
  // row again and answers device_revoked. Once a revoke has answered, no key leaves the server.
  // It follows the sign-in like a pull, so a revoke after a reload ends the session in use now.
  // No audit row: the app asks at every online opening, and the row says nothing new.
  key(id: string): Promise<DeviceKey> {
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)))
        .for('share');
      if (row?.userId !== currentPrincipal().userId) throw deviceNotFound();
      if (row.revokedAt !== null) throw deviceRevoked();
      // devices_secret_check (migration 0050): an active device always has its key
      if (row.secret === null) throw new Error(`device ${id} is active without a key`);
      await this.keepSession(tx, row);
      return { key: row.secret.toString('base64') };
    });
  }

  // Step 18c (decision 13): the device remembers the sign-in it is used with, so a revoke can end
  // it. Written only when it changed (a new sign-in on the same browser), so most requests write
  // nothing. A raw statement, like the pull's last_sync_at: no version and no updated_at, or a
  // sign-in would make the person's rename fail on its version. revoked_at IS NULL: a revoke that
  // committed after the caller read the row wins, and the trigger never sees a revoked row change.
  async keepSession(tx: Transaction, row: DeviceRow): Promise<void> {
    const { sessionId } = currentPrincipal();
    if (row.revokedAt !== null || row.sessionId === sessionId) return;
    await tx.execute(
      sql`UPDATE devices SET session_id = ${sessionId}::uuid
           WHERE tenant_id = ${getTenantId()}::uuid AND id = ${row.id}::uuid
             AND revoked_at IS NULL`,
    );
  }

  // The signed-in person's devices here, active first, then by name. All of them in one answer:
  // a person has a few (decision 8).
  mine(): Promise<MyDeviceList> {
    return this.withTenant(async (tx) => {
      const rows = await this.selectList(tx)
        .where(
          and(eq(devices.tenantId, getTenantId()), eq(devices.userId, currentPrincipal().userId)),
        )
        .orderBy(sql`${devices.revokedAt} IS NOT NULL`, asc(devices.name), asc(devices.id));
      return { items: rows.map(toListItem) };
    });
  }

  // Every device of the workspace (core.device.manage, checked on the route), one page at a time
  list(query: {
    search?: string | undefined;
    branchId?: string | undefined;
    status: DeviceStatus;
    sort: DeviceSort;
    limit: number;
    cursor?: string | undefined;
  }): Promise<DevicePage> {
    // cursor = [sort, the last row's key, its id]. The sort is checked as a literal: a cursor made
    // for another sort would start the page at the wrong place, so it is a 400 instead. The key of
    // the sync sorts is a whole number (syncKey), anything else is refused before it reaches SQL.
    const bySync = isSyncSort(query.sort);
    const after = decodeCursor(
      query.cursor,
      z.tuple([
        z.literal(query.sort),
        bySync ? z.string().regex(/^-?\d{1,19}$/) : z.string(),
        z.uuid(),
      ]),
    );
    const descending = query.sort.startsWith('-');
    const direction = descending ? desc : asc;
    const key = bySync ? syncKey : sql`${devices.name}`;

    const conditions: (SQL | undefined)[] = [
      eq(devices.tenantId, getTenantId()),
      query.status === 'active' ? isNull(devices.revokedAt) : isNotNull(devices.revokedAt),
      query.branchId === undefined ? undefined : eq(devices.branchId, query.branchId),
    ];
    if (query.search) {
      // The device's name or its person's name (decision 8). No index helps a "contains"; a
      // workspace has a few hundred devices at most (decision 15).
      const pattern = containsPattern(query.search);
      conditions.push(
        or(
          sql`lower(${devices.name}) LIKE ${pattern}`,
          sql`lower(${users.fullName}) LIKE ${pattern}`,
        ),
      );
    }
    if (after) {
      // (key, id) pairs: the id (unique) breaks ties between two devices with the same name or the
      // same sync time. The key is cast back to what it is: text for a name, bigint for a time.
      const cursorKey = bySync ? sql`${after[1]}::bigint` : sql`${after[1]}`;
      conditions.push(
        descending
          ? sql`(${key}, ${devices.id}) < (${cursorKey}, ${after[2]}::uuid)`
          : sql`(${key}, ${devices.id}) > (${cursorKey}, ${after[2]}::uuid)`,
      );
    }

    return this.withTenant(async (tx) => {
      const rows = await tx
        // The key as text: a bigint comes back from the driver as a string anyway, and the cursor
        // keeps it as one
        .select({ ...listColumns, key: sql<string>`${key}::text` })
        .from(devices)
        .innerJoin(users, eq(users.id, devices.userId))
        .innerJoin(
          branches,
          and(eq(branches.tenantId, devices.tenantId), eq(branches.id, devices.branchId)),
        )
        .leftJoin(revoker, eq(revoker.id, devices.revokedBy))
        .where(and(...conditions))
        .orderBy(direction(key), direction(devices.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [query.sort, last.key, last.device.id]);
      return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
    });
  }

  // Your own device, or anyone's with core.device.manage (decision 5)
  async rename(id: string, input: RenameDeviceInput): Promise<DeviceListItem> {
    const access = await this.permissions.ofCurrentUser();
    return this.withTenant(async (tx) => {
      const before = await this.lockVisible(tx, id, access);
      // Revoked first: a reload after a version conflict would only end in this anyway
      if (before.revokedAt !== null) throw deviceRevoked();
      if (before.version !== input.version) throw versionConflict();
      if (before.name !== input.name) {
        await tx
          .update(devices)
          .set({
            name: input.name,
            version: sql`${devices.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)));
        await audit(tx, {
          action: 'device.renamed',
          entityType: 'device',
          entityId: id,
          changes: diff({ name: before.name }, { name: input.name }),
        });
      }
      return this.item(tx, id);
    });
  }

  // Your own device only, even with core.device.manage (decision 2): only the device knows that
  // its outbox is empty, and the app checks that before it asks (decision 10)
  move(id: string, input: MoveDeviceInput): Promise<DeviceListItem> {
    return this.withTenant(async (tx) => {
      const before = await this.lockOwn(tx, id);
      if (before.revokedAt !== null) throw deviceRevoked();
      if (before.version !== input.version) throw versionConflict();
      // The branch it is in already: nothing changes, no audit row (decision 10)
      if (before.branchId === input.branchId) return this.item(tx, id);

      // FOR SHARE on the new branch, like registering: an archive of it waits for this commit,
      // and then sees the device in it (branch_has_devices)
      const to = await this.activeBranchCode(tx, input.branchId);
      const [from] = await tx
        .select({ code: branches.code })
        .from(branches)
        .where(and(eq(branches.tenantId, getTenantId()), eq(branches.id, before.branchId)));
      await tx
        .update(devices)
        .set({
          branchId: input.branchId,
          version: sql`${devices.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)));
      await audit(tx, {
        action: 'device.moved',
        entityType: 'device',
        entityId: id,
        changes: diff({ branch: from?.code ?? null }, { branch: to }),
      });
      // Nothing else: the device's next pull sees a cursor of the old branch and starts a full
      // pull of the new one (SyncService.restartsFull)
      return this.item(tx, id);
    });
  }

  // Your own device, or anyone's with core.device.manage. Final, and safe to repeat: a revoked
  // device is answered as it is (decision 9).
  async revoke(id: string): Promise<DeviceListItem> {
    const access = await this.permissions.ofCurrentUser();
    return this.withTenant(async (tx) => {
      const before = await this.lockVisible(tx, id, access);
      if (before.revokedAt === null) await revokeDevices(tx, [before]);
      return this.item(tx, id);
    });
  }

  // The list's select, without its WHERE: the person, the branch and who revoked it
  private selectList(tx: Transaction) {
    return tx
      .select(listColumns)
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .innerJoin(
        branches,
        and(eq(branches.tenantId, devices.tenantId), eq(branches.id, devices.branchId)),
      )
      .leftJoin(revoker, eq(revoker.id, devices.revokedBy));
  }

  // One device as the lists show it, read after a change in the same transaction
  private async item(tx: Transaction, id: string): Promise<DeviceListItem> {
    const [row] = await this.selectList(tx).where(
      and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)),
    );
    if (!row) throw deviceNotFound();
    return toListItem(row);
  }

  // The device, locked until the commit: two renames, or a rename and a revoke, one after the
  // other. Someone else's device without core.device.manage is device_not_found, like an id that
  // does not exist (decision 5).
  private async lockVisible(tx: Transaction, id: string, access: Access): Promise<DeviceRow> {
    const row = await this.lock(tx, id);
    if (
      row.userId !== currentPrincipal().userId &&
      !access.permissions.includes('core.device.manage')
    ) {
      throw deviceNotFound();
    }
    return row;
  }

  private async lockOwn(tx: Transaction, id: string): Promise<DeviceRow> {
    const row = await this.lock(tx, id);
    if (row.userId !== currentPrincipal().userId) throw deviceNotFound();
    return row;
  }

  private async lock(tx: Transaction, id: string): Promise<DeviceRow> {
    const [row] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)))
      .for('update');
    if (!row) throw deviceNotFound();
    return row;
  }

  // An active branch of this workspace, by its code for the audit log. FOR SHARE: nobody archives
  // it before we commit.
  private async activeBranchCode(tx: Transaction, id: string): Promise<string> {
    const [branch] = await tx
      .select({ code: branches.code })
      .from(branches)
      .where(
        and(eq(branches.tenantId, getTenantId()), eq(branches.id, id), isNull(branches.archivedAt)),
      )
      .for('share');
    if (!branch) {
      throw new AppError(409, 'device_branch_invalid', 'Pick an active branch.', {
        fieldErrors: { branchId: ['device_branch_invalid'] },
      });
    }
    return branch.code;
  }

  // The device with this id, when it is the signed-in person's. Another person's id in this
  // workspace is device_id_invalid: their device keeps its id, and this browser makes a new one.
  private async ownedOrNone(tx: Transaction, id: string): Promise<DeviceRow | undefined> {
    const [row] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)));
    if (!row) return undefined;
    if (row.userId !== currentPrincipal().userId) {
      throw new AppError(409, 'device_id_invalid', 'Make a new id for this device.');
    }
    return row;
  }
}
