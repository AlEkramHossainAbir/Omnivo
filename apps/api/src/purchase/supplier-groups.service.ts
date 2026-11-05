import { Inject, Injectable } from '@nestjs/common';
import type { SupplierGroup, SupplierGroupInput } from '@omnivo/contracts';
import { supplierGroups, parties } from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type GroupRow = typeof supplierGroups.$inferSelect;

// Every supplier in the group, archived ones too: they still hold the FK that stops a delete.
// The outer table by its name: Drizzle would print ${supplierGroups.id} as a bare "id", which
// inside this subquery means the party's own id.
const supplierCount = sql<number>`(
  SELECT count(*)::int FROM ${parties} p
   WHERE p.tenant_id = supplier_groups.tenant_id AND p.supplier_group_id = supplier_groups.id
)`;

function toGroup(row: GroupRow, count: number): SupplierGroup {
  return {
    id: row.id,
    name: row.name,
    supplierCount: count,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nameTaken(): AppError {
  return new AppError(409, 'supplier_group_name_taken', 'Another group already has this name.', {
    fieldErrors: { name: ['supplier_group_name_taken'] },
  });
}

// Local, Importer, Raw material, Packaging (step 17a), like the customer groups of step 15a.
// Deleted for real, and only while empty: a group is a label for filtering, with no history of
// its own worth keeping.
@Injectable()
export class SupplierGroupsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<SupplierGroup[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ group: supplierGroups, supplierCount })
        .from(supplierGroups)
        .where(eq(supplierGroups.tenantId, getTenantId()))
        .orderBy(asc(sql`lower(${supplierGroups.name})`));
      return rows.map((row) => toGroup(row.group, row.supplierCount));
    });
  }

  async create(input: SupplierGroupInput): Promise<SupplierGroup> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(supplierGroups)
          .values({
            tenantId: getTenantId(),
            name: input.name,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Supplier group insert returned no row');
        await audit(tx, {
          action: 'supplier_group.created',
          entityType: 'supplier_group',
          entityId: row.id,
          changes: created({ name: row.name }),
        });
        return toGroup(row, 0);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'supplier_groups_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(
    id: string,
    input: SupplierGroupInput & { version: number },
  ): Promise<SupplierGroup> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        await tx
          .update(supplierGroups)
          .set({
            name: input.name,
            version: sql`${supplierGroups.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(supplierGroups.tenantId, getTenantId()), eq(supplierGroups.id, id)));
        await audit(tx, {
          action: 'supplier_group.updated',
          entityType: 'supplier_group',
          entityId: id,
          changes: diff({ name: before.name }, { name: input.name }),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'supplier_groups_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        await tx
          .delete(supplierGroups)
          .where(and(eq(supplierGroups.tenantId, getTenantId()), eq(supplierGroups.id, id)));
        await audit(tx, {
          action: 'supplier_group.deleted',
          entityType: 'supplier_group',
          entityId: id,
          changes: diff({ name: before.name }, { name: null }),
        });
      });
    } catch (error) {
      // No count first: the FK is the check, and it cannot miss a supplier saved a moment ago
      if (isForeignKeyViolation(error, 'parties_supplier_group_fk')) {
        throw new AppError(
          409,
          'supplier_group_in_use',
          'Suppliers are in this group. Move them to another group first.',
        );
      }
      throw error;
    }
  }

  private async lock(tx: Transaction, id: string): Promise<GroupRow> {
    const [row] = await tx
      .select()
      .from(supplierGroups)
      .where(and(eq(supplierGroups.tenantId, getTenantId()), eq(supplierGroups.id, id)))
      .for('update');
    if (!row) throw notFound('Supplier group');
    return row;
  }

  private async read(tx: Transaction, id: string): Promise<SupplierGroup> {
    const [row] = await tx
      .select({ group: supplierGroups, supplierCount })
      .from(supplierGroups)
      .where(and(eq(supplierGroups.tenantId, getTenantId()), eq(supplierGroups.id, id)));
    if (!row) throw notFound('Supplier group');
    return toGroup(row.group, row.supplierCount);
  }
}
