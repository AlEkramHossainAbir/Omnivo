import { Inject, Injectable } from '@nestjs/common';
import {
  type ErrorCode,
  moneyAccountIds,
  POS_PAYMENT_METHODS,
  type PosPaymentMethod,
  type PosRegister,
  type PosRegisterInput,
  type PosRegisterListItem,
  type PosRegisterStatus,
  type SyncPosRegister,
  type UpdatePosRegisterInput,
} from '@omnivo/contracts';
import { devices, ledgerAccounts, posRegisters, users, warehouses } from '@omnivo/db';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { deviceNotFound, deviceRevoked } from '../sync/devices.service.js';

export type PosRegisterRow = typeof posRegisters.$inferSelect;

// The account column of each payment method
const ACCOUNT_COLUMN = {
  cash: 'cashAccountId',
  card: 'cardAccountId',
  bkash: 'bkashAccountId',
  nagad: 'nagadAccountId',
} as const satisfies Record<PosPaymentMethod, keyof PosRegisterRow>;

// The register's account for a method; null = it does not take that method (cash always has one)
export function accountOf(row: PosRegisterRow, method: PosPaymentMethod): string | null {
  return row[ACCOUNT_COLUMN[method]];
}

// A register as the devices keep it (decision 20): without the last number, which changes with
// every sale. branchId is the warehouse's (decision 17): the caller reads it with the row.
export function toSyncPosRegister(row: PosRegisterRow, branchId: string): SyncPosRegister {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    branchId,
    warehouseId: row.warehouseId,
    accounts: {
      cash: row.cashAccountId,
      card: row.cardAccountId,
      bkash: row.bkashAccountId,
      nagad: row.nagadAccountId,
    },
    maxDiscountPercent: row.maxDiscountPercent,
    paperWidth: row.paperWidth,
    receiptFooter: row.receiptFooter,
    deviceId: row.deviceId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPosRegister(row: PosRegisterRow, branchId: string): PosRegister {
  return { ...toSyncPosRegister(row, branchId), lastNumber: row.lastNumber };
}

// What the audit log shows of a register's form: the warehouse by its code, the accounts by
// their codes, so a reader sees "1110" and not an id
type Snapshot = Record<string, string | null>;

function fieldError(code: ErrorCode, field: string, detail: string): AppError {
  return new AppError(409, code, detail, { fieldErrors: { [field]: [code] } });
}

function codeTaken(): AppError {
  return fieldError('pos_register_code_taken', 'code', 'Another register uses this code.');
}

function wrongBranch(): AppError {
  return fieldError(
    'pos_register_branch',
    'warehouseId',
    'A device holds this register, so its warehouse stays in that branch.',
  );
}

function inUse(): AppError {
  return new AppError(
    409,
    'pos_register_in_use',
    'Another device holds this register. Sign out there first, or revoke that device.',
  );
}

function deviceHasRegister(): AppError {
  return new AppError(
    409,
    'pos_device_has_register',
    'This device holds another register. Let go of that one first.',
  );
}

// The database's last words (migration 0052, schema/pos.ts), caught outside the transaction after
// its rollback (step 6's pattern). Each has a check before it in the code; these are for the race
// the check cannot see: two creates with one code, a claim and a revoke at the same moment.
function databaseError(error: unknown): unknown {
  if (isUniqueViolation(error, 'pos_registers_tenant_code_idx')) return codeTaken();
  if (isUniqueViolation(error, 'pos_registers_device_idx')) return deviceHasRegister();
  if (isCheckViolation(error, 'pos_registers_holder_check')) return wrongBranch();
  if (isCheckViolation(error, 'pos_registers_archived_check')) return inUse();
  return error;
}

// POS registers (step 20a): set up by someone with pos.register.manage, claimed and released by
// the devices that sell on them. A claim and a release never change the register's version: who
// holds it is not part of its form, so a manager's open form does not fail on it (the database's
// own release, when a device is revoked or moved, does the same).
@Injectable()
export class PosRegistersService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(query: {
    status: PosRegisterStatus;
    branchId?: string | undefined;
  }): Promise<PosRegisterListItem[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({
          register: posRegisters,
          branchId: warehouses.branchId,
          deviceName: devices.name,
          userName: users.fullName,
        })
        .from(posRegisters)
        .innerJoin(
          warehouses,
          and(
            eq(warehouses.tenantId, posRegisters.tenantId),
            eq(warehouses.id, posRegisters.warehouseId),
          ),
        )
        .leftJoin(
          devices,
          and(eq(devices.tenantId, posRegisters.tenantId), eq(devices.id, posRegisters.deviceId)),
        )
        .leftJoin(users, eq(users.id, devices.userId))
        .where(
          and(
            eq(posRegisters.tenantId, getTenantId()),
            query.status === 'active'
              ? isNull(posRegisters.archivedAt)
              : isNotNull(posRegisters.archivedAt),
            query.branchId === undefined ? undefined : eq(warehouses.branchId, query.branchId),
          ),
        )
        .orderBy(asc(posRegisters.code));
      return rows.map((row) => ({
        ...toPosRegister(row.register, row.branchId),
        holder:
          row.deviceName === null || row.userName === null
            ? null
            : { deviceName: row.deviceName, userName: row.userName },
      }));
    });
  }

  get(id: string): Promise<PosRegister> {
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, id);
      return toPosRegister(row, await this.branchOf(tx, row.warehouseId));
    });
  }

  async create(input: PosRegisterInput): Promise<PosRegister> {
    try {
      return await this.withTenant(async (tx) => {
        const warehouse = await this.activeWarehouse(tx, input.warehouseId);
        await this.checkAccounts(tx, input.accounts);
        const [row] = await tx
          .insert(posRegisters)
          .values({
            tenantId: getTenantId(),
            code: input.code,
            name: input.name,
            warehouseId: input.warehouseId,
            ...this.accountColumns(input.accounts),
            maxDiscountPercent: input.maxDiscountPercent,
            paperWidth: input.paperWidth,
            receiptFooter: input.receiptFooter,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('POS register insert returned no row');
        await audit(tx, {
          action: 'pos_register.created',
          entityType: 'pos_register',
          entityId: row.id,
          changes: created({ code: row.code, ...(await this.snapshot(tx, row)) }),
        });
        return toPosRegister(row, warehouse.branchId);
      });
    } catch (error) {
      throw databaseError(error);
    }
  }

  async update(id: string, input: UpdatePosRegisterInput): Promise<PosRegister> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        // An archived register's warehouse may be archived since: only a new choice must be active
        const warehouse =
          input.warehouseId === before.warehouseId
            ? { branchId: await this.branchOf(tx, before.warehouseId) }
            : await this.activeWarehouse(tx, input.warehouseId);
        // A held register stays in its device's branch: the device may still have sales of it to
        // send. The database checks it again (pos_registers_holder_check).
        if (
          before.deviceId !== null &&
          warehouse.branchId !== (await this.branchOf(tx, before.warehouseId))
        ) {
          throw wrongBranch();
        }
        await this.checkAccounts(tx, input.accounts);
        const [after] = await tx
          .update(posRegisters)
          .set({
            name: input.name,
            warehouseId: input.warehouseId,
            ...this.accountColumns(input.accounts),
            maxDiscountPercent: input.maxDiscountPercent,
            paperWidth: input.paperWidth,
            receiptFooter: input.receiptFooter,
            version: sql`${posRegisters.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)))
          .returning();
        if (!after) throw notFound('POS register');
        await audit(tx, {
          action: 'pos_register.updated',
          entityType: 'pos_register',
          entityId: id,
          changes: diff(await this.snapshot(tx, before), await this.snapshot(tx, after)),
        });
        return toPosRegister(after, warehouse.branchId);
      });
    } catch (error) {
      throw databaseError(error);
    }
  }

  async setArchived(id: string, version: number, archived: boolean): Promise<PosRegister> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        if ((before.archivedAt !== null) === archived) {
          return toPosRegister(before, await this.branchOf(tx, before.warehouseId));
        }
        // Decision 33: only the device knows whether a sale of it still waits in its outbox
        if (archived && before.deviceId !== null) throw inUse();
        // Its warehouse may have been archived meanwhile: a register comes back to an active one
        const branchId = archived
          ? await this.branchOf(tx, before.warehouseId)
          : (await this.activeWarehouse(tx, before.warehouseId)).branchId;
        const [after] = await tx
          .update(posRegisters)
          .set({
            archivedAt: archived ? new Date() : null,
            version: sql`${posRegisters.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)))
          .returning();
        if (!after) throw notFound('POS register');
        await audit(tx, {
          action: archived ? 'pos_register.archived' : 'pos_register.restored',
          entityType: 'pos_register',
          entityId: id,
        });
        return toPosRegister(after, branchId);
      });
    } catch (error) {
      throw databaseError(error);
    }
  }

  // Decision 14: a device takes a register only when no device holds it. The answer carries the
  // last number, and the device numbers its sales on from there. Taking the one it holds already
  // answers the same, so a claim sent again after a lost answer is harmless.
  async claim(id: string, deviceId: string): Promise<PosRegister> {
    try {
      return await this.withTenant(async (tx) => {
        // The device first, then the register: a revoke locks them in that order (0052), and a
        // claim in the other order could wait for it in a circle
        const device = await this.ownDevice(tx, deviceId);
        const before = await this.lock(tx, id);
        const branchId = await this.branchOf(tx, before.warehouseId);
        if (before.deviceId === device.id) return toPosRegister(before, branchId);
        if (before.archivedAt !== null) {
          throw new AppError(409, 'pos_register_archived', 'This register is archived.');
        }
        if (before.deviceId !== null) throw inUse();
        if (branchId !== device.branchId) {
          throw new AppError(
            409,
            'pos_register_branch',
            "This register is in another branch than this device. Pick one of the device's branch.",
          );
        }
        const [held] = await tx
          .select({ id: posRegisters.id })
          .from(posRegisters)
          .where(
            and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.deviceId, device.id)),
          );
        if (held) throw deviceHasRegister();
        const after = await this.setHolder(tx, id, device.id);
        await audit(tx, {
          action: 'pos_register.claimed',
          entityType: 'pos_register',
          entityId: id,
          changes: { device: { from: null, to: device.name } },
        });
        return toPosRegister(after, branchId);
      });
    } catch (error) {
      throw databaseError(error);
    }
  }

  // The device lets go of its register: the app calls it at sign-out, after it checked that no
  // sale of the register waits in its outbox (decision 32). A register that is free already
  // answers as it is (a release sent again); one another device holds is not this device's to free.
  release(id: string, deviceId: string): Promise<PosRegister> {
    return this.withTenant(async (tx) => {
      const device = await this.ownDevice(tx, deviceId);
      const before = await this.lock(tx, id);
      const branchId = await this.branchOf(tx, before.warehouseId);
      if (before.deviceId === null) return toPosRegister(before, branchId);
      if (before.deviceId !== device.id) {
        throw new AppError(409, 'pos_register_not_held', 'This device does not hold the register.');
      }
      const after = await this.setHolder(tx, id, null);
      await audit(tx, {
        action: 'pos_register.released',
        entityType: 'pos_register',
        entityId: id,
        changes: { device: { from: device.name, to: null } },
      });
      return toPosRegister(after, branchId);
    });
  }

  // No version: see the class's comment
  private async setHolder(
    tx: Transaction,
    id: string,
    deviceId: string | null,
  ): Promise<PosRegisterRow> {
    const [after] = await tx
      .update(posRegisters)
      .set({ deviceId, updatedBy: currentPrincipal().userId })
      .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)))
      .returning();
    if (!after) throw notFound('POS register');
    return after;
  }

  // The signed-in person's own active device, FOR SHARE: a revoke or a move of it that is running
  // finishes first, and this sees its result. Another person's device answers like an unknown one.
  private async ownDevice(tx: Transaction, id: string) {
    const [row] = await tx
      .select({
        id: devices.id,
        name: devices.name,
        userId: devices.userId,
        branchId: devices.branchId,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)))
      .for('share');
    if (row?.userId !== currentPrincipal().userId) throw deviceNotFound();
    if (row.revokedAt !== null) throw deviceRevoked();
    return row;
  }

  private async find(tx: Transaction, id: string): Promise<PosRegisterRow> {
    const [row] = await tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)));
    if (!row) throw notFound('POS register');
    return row;
  }

  private async lock(tx: Transaction, id: string): Promise<PosRegisterRow> {
    const [row] = await tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)))
      .for('update');
    if (!row) throw notFound('POS register');
    return row;
  }

  // A warehouse is never deleted, so the FK keeps it while a register points at it
  private async branchOf(tx: Transaction, warehouseId: string): Promise<string> {
    const [row] = await tx
      .select({ branchId: warehouses.branchId })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, warehouseId)));
    if (!row) throw new Error(`Warehouse ${warehouseId} of a POS register is missing`);
    return row.branchId;
  }

  // An active warehouse of this workspace, FOR SHARE: nobody archives it or moves it to another
  // branch until we commit
  private async activeWarehouse(tx: Transaction, id: string): Promise<{ branchId: string }> {
    const [row] = await tx
      .select({ branchId: warehouses.branchId })
      .from(warehouses)
      .where(
        and(
          eq(warehouses.tenantId, getTenantId()),
          eq(warehouses.id, id),
          isNull(warehouses.archivedAt),
        ),
      )
      .for('share');
    if (!row) {
      throw fieldError(
        'pos_register_warehouse_invalid',
        'warehouseId',
        'Pick an active warehouse.',
      );
    }
    return row;
  }

  // Every chosen account is a money account (contracts' moneyAccountIds, the form's own list), all
  // problems at once under accounts.card and so on. The chart is read once: a few hundred rows.
  // FOR SHARE on the chosen ones: nobody archives them before we commit.
  private async checkAccounts(tx: Transaction, accounts: PosRegisterInput['accounts']) {
    const chart = await tx
      .select({
        id: ledgerAccounts.id,
        parentId: ledgerAccounts.parentId,
        isGroup: ledgerAccounts.isGroup,
        holdsMoney: ledgerAccounts.holdsMoney,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.tenantId, getTenantId()));
    const money = moneyAccountIds(
      chart.map((account) => ({
        ...account,
        archivedAt: account.archivedAt?.toISOString() ?? null,
      })),
    );
    const chosen = POS_PAYMENT_METHODS.flatMap((method) => {
      const id = accounts[method];
      return id === null ? [] : [{ method, id }];
    });
    const bad = chosen.filter((choice) => !money.has(choice.id));
    if (bad.length > 0) {
      throw new AppError(
        409,
        'pos_register_account_invalid',
        'Pick a cash, bank or mobile wallet account.',
        {
          fieldErrors: Object.fromEntries(
            bad.map((choice) => [`accounts.${choice.method}`, ['pos_register_account_invalid']]),
          ),
        },
      );
    }
    await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, getTenantId()),
          inArray(
            ledgerAccounts.id,
            chosen.map((choice) => choice.id),
          ),
        ),
      )
      .for('share');
  }

  private accountColumns(accounts: PosRegisterInput['accounts']) {
    return {
      cashAccountId: accounts.cash,
      cardAccountId: accounts.card,
      bkashAccountId: accounts.bkash,
      nagadAccountId: accounts.nagad,
    };
  }

  private async snapshot(tx: Transaction, row: PosRegisterRow): Promise<Snapshot> {
    const ids = POS_PAYMENT_METHODS.flatMap((method) => {
      const id = accountOf(row, method);
      return id === null ? [] : [id];
    });
    const codes = new Map(
      (
        await tx
          .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.tenantId, getTenantId()), inArray(ledgerAccounts.id, ids)))
      ).map((account) => [account.id, account.code]),
    );
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    const codeOf = (method: PosPaymentMethod) => {
      const id = accountOf(row, method);
      return id === null ? null : (codes.get(id) ?? null);
    };
    return {
      name: row.name,
      warehouse: warehouse?.code ?? null,
      cashAccount: codeOf('cash'),
      cardAccount: codeOf('card'),
      bkashAccount: codeOf('bkash'),
      nagadAccount: codeOf('nagad'),
      maxDiscountPercent: row.maxDiscountPercent,
      paperWidth: row.paperWidth,
      receiptFooter: row.receiptFooter,
    };
  }
}
