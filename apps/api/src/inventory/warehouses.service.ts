import { Inject, Injectable } from '@nestjs/common';
import type {
  UpdateWarehouseInput,
  Warehouse,
  WarehouseInput,
  WarehouseStatus,
} from '@omnivo/contracts';
import { branches, stockBalances, stockMovements, stockTransfers, warehouses } from '@omnivo/db';
import { and, asc, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type WarehouseRow = typeof warehouses.$inferSelect;

function toWarehouse(row: WarehouseRow): Warehouse {
  return {
    id: row.id,
    branchId: row.branchId,
    code: row.code,
    name: row.name,
    address: row.address,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit log shows: the form's fields, with the branch by its code
function snapshot(row: Pick<WarehouseRow, 'code' | 'name' | 'address'>, branch: string | null) {
  return { code: row.code, name: row.name, address: row.address, branch };
}

function codeTaken(code: string): AppError {
  return new AppError(409, 'warehouse_code_taken', `Warehouse code ${code} is already used.`, {
    fieldErrors: { code: ['warehouse_code_taken'] },
  });
}

@Injectable()
export class WarehousesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(status: WarehouseStatus): Promise<Warehouse[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(warehouses)
        .where(
          and(
            eq(warehouses.tenantId, getTenantId()),
            status === 'active' ? isNull(warehouses.archivedAt) : isNotNull(warehouses.archivedAt),
          ),
        )
        .orderBy(asc(warehouses.code));
      return rows.map(toWarehouse);
    });
  }

  async create(input: WarehouseInput): Promise<Warehouse> {
    try {
      return await this.withTenant(async (tx) => {
        const branch = await this.activeBranch(tx, input.branchId);
        const [row] = await tx
          .insert(warehouses)
          .values({ tenantId: getTenantId(), ...input, createdBy: currentPrincipal().userId })
          .returning();
        if (!row) throw new Error('Warehouse insert returned no row');
        await audit(tx, {
          action: 'warehouse.created',
          entityType: 'warehouse',
          entityId: row.id,
          changes: created(snapshot(row, branch)),
        });
        return toWarehouse(row);
      });
    } catch (error) {
      // Caught outside the transaction, after the rollback (step 6's pattern)
      if (isUniqueViolation(error, 'warehouses_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  async update(id: string, input: UpdateWarehouseInput): Promise<Warehouse> {
    const tenantId = getTenantId();
    try {
      return await this.withTenant(async (tx) => {
        const { version, ...fields } = input;
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        const oldBranch = await this.branchCode(tx, before.branchId);
        const newBranch =
          fields.branchId === before.branchId
            ? oldBranch
            : await this.activeBranch(tx, fields.branchId);
        // Its history belongs to the branch it was in: moving a warehouse that already has
        // movements would move years of stock (and, from step 14, its value) to another branch
        if (fields.branchId !== before.branchId && (await this.hasMovements(tx, id))) {
          throw new AppError(
            409,
            'warehouse_branch_locked',
            'A warehouse with stock history stays in its branch.',
            { fieldErrors: { branchId: ['warehouse_branch_locked'] } },
          );
        }
        const [after] = await tx
          .update(warehouses)
          .set({
            ...fields,
            version: sql`${warehouses.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, id)))
          .returning();
        if (!after) throw notFound('Warehouse');
        await audit(tx, {
          action: 'warehouse.updated',
          entityType: 'warehouse',
          entityId: id,
          changes: diff(snapshot(before, oldBranch), snapshot(after, newBranch)),
        });
        return toWarehouse(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'warehouses_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  setArchived(id: string, version: number, archived: boolean): Promise<Warehouse> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // FOR UPDATE: documents being posted hold it FOR SHARE (assertWarehousesActive), so an
      // archive waits for them — and then sees the stock they brought in
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) === archived) return toWarehouse(before);
      if (archived) {
        // Stock in it would vanish from every list. Move it out or adjust it to zero first.
        const [stock] = await tx
          .select({ quantity: stockBalances.quantity })
          .from(stockBalances)
          .where(
            and(
              eq(stockBalances.tenantId, tenantId),
              eq(stockBalances.warehouseId, id),
              ne(stockBalances.quantity, '0'),
            ),
          )
          .limit(1);
        if (stock) {
          throw new AppError(409, 'warehouse_has_stock', 'Move or adjust its stock out first.');
        }
        // A truck on its way to or from it still has to arrive somewhere
        const [moving] = await tx
          .select({ id: stockTransfers.id })
          .from(stockTransfers)
          .where(
            and(
              eq(stockTransfers.tenantId, tenantId),
              eq(stockTransfers.status, 'in_transit'),
              or(eq(stockTransfers.fromWarehouseId, id), eq(stockTransfers.toWarehouseId, id)),
            ),
          )
          .limit(1);
        if (moving) {
          throw new AppError(
            409,
            'warehouse_has_transfers',
            'Receive the transfers on their way first.',
          );
        }
      } else {
        // Its branch may have been archived meanwhile: a warehouse comes back to an active branch
        await this.activeBranch(tx, before.branchId);
      }
      const [after] = await tx
        .update(warehouses)
        .set({
          archivedAt: archived ? new Date() : null,
          version: sql`${warehouses.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, id)))
        .returning();
      if (!after) throw notFound('Warehouse');
      await audit(tx, {
        action: archived ? 'warehouse.archived' : 'warehouse.restored',
        entityType: 'warehouse',
        entityId: id,
      });
      return toWarehouse(after);
    });
  }

  private async lock(tx: Transaction, id: string): Promise<WarehouseRow> {
    const [row] = await tx
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, id)))
      .for('update');
    if (!row) throw notFound('Warehouse');
    return row;
  }

  // An active branch of this workspace, locked against archiving until we commit
  // (BranchesService.archive refuses a branch with active warehouses). Returns its code.
  private async activeBranch(tx: Transaction, branchId: string): Promise<string> {
    const [branch] = await tx
      .select({ code: branches.code })
      .from(branches)
      .where(
        and(
          eq(branches.tenantId, getTenantId()),
          eq(branches.id, branchId),
          isNull(branches.archivedAt),
        ),
      )
      .for('share');
    if (!branch) {
      throw new AppError(409, 'warehouse_branch_invalid', 'Pick an active branch.', {
        fieldErrors: { branchId: ['warehouse_branch_invalid'] },
      });
    }
    return branch.code;
  }

  private async branchCode(tx: Transaction, branchId: string): Promise<string | null> {
    const [branch] = await tx
      .select({ code: branches.code })
      .from(branches)
      .where(and(eq(branches.tenantId, getTenantId()), eq(branches.id, branchId)));
    return branch?.code ?? null;
  }

  private async hasMovements(tx: Transaction, id: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(and(eq(stockMovements.tenantId, getTenantId()), eq(stockMovements.warehouseId, id)))
      .limit(1);
    return row !== undefined;
  }
}
