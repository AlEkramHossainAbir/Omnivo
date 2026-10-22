import { Inject, Injectable } from '@nestjs/common';
import type { Device, RegisterDeviceInput } from '@omnivo/contracts';
import { branches, devices } from '@omnivo/db';
import { and, eq, isNull } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { AppError } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

export type DeviceRow = typeof devices.$inferSelect;

function toDevice(row: DeviceRow): Device {
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

@Injectable()
export class DevicesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // Decision 20: the browser makes the id, so registering is safe to repeat. The same id by the
  // same person returns the device as it is, even when the name or the branch sent differ (a
  // retry of a lost answer sends the same ones; changing them is step 18c's rename and move).
  register(input: RegisterDeviceInput): Promise<Device> {
    return this.withTenant(async (tx) => {
      const known = await this.ownedOrNone(tx, input.id);
      if (known) return toDevice(known);

      const branch = await this.activeBranchCode(tx, input.branchId);
      const userId = currentPrincipal().userId;
      const [row] = await tx
        .insert(devices)
        .values({
          id: input.id,
          tenantId: getTenantId(),
          userId,
          name: input.name,
          branchId: input.branchId,
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
    if (row.revokedAt !== null) {
      throw new AppError(403, 'device_revoked', 'This device was revoked. Its data is wiped.');
    }
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
