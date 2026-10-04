import { Inject, Injectable } from '@nestjs/common';
import type { CreateUnitInput, Unit, UpdateUnitInput } from '@omnivo/contracts';
import { units } from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type UnitRow = typeof units.$inferSelect;

function toUnit(row: UnitRow): Unit {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    dimension: row.dimension,
    ratio: row.ratio,
    decimals: row.decimals,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshot(row: Pick<UnitRow, 'code' | 'name' | 'decimals'>) {
  return { code: row.code, name: row.name, decimals: row.decimals };
}

function codeTaken(): AppError {
  return new AppError(409, 'unit_code_taken', 'Another unit already uses this code.', {
    fieldErrors: { code: ['unit_code_taken'] },
  });
}

@Injectable()
export class UnitsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<Unit[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(units)
        .where(eq(units.tenantId, getTenantId()))
        .orderBy(asc(units.dimension), asc(units.ratio), asc(units.code));
      return rows.map(toUnit);
    });
  }

  async create(input: CreateUnitInput): Promise<Unit> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(units)
          .values({ tenantId: getTenantId(), ...input, createdBy: currentPrincipal().userId })
          .returning();
        if (!row) throw new Error('Unit insert returned no row');
        await audit(tx, {
          action: 'unit.created',
          entityType: 'unit',
          entityId: row.id,
          changes: created({ ...snapshot(row), dimension: row.dimension, ratio: row.ratio }),
        });
        return toUnit(row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'units_tenant_code_idx')) throw codeTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdateUnitInput): Promise<Unit> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        const after = await this.write(tx, id, {
          code: input.code,
          name: input.name,
          decimals: input.decimals,
        });
        await audit(tx, {
          action: 'unit.updated',
          entityType: 'unit',
          entityId: id,
          changes: diff(snapshot(before), snapshot(after)),
        });
        return toUnit(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'units_tenant_code_idx')) throw codeTaken();
      throw error;
    }
  }

  // Archived: hidden from new products. Products that use it keep it, and can still be saved.
  setArchived(id: string, version: number, archived: boolean): Promise<Unit> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) === archived) return toUnit(before);
      const after = await this.write(tx, id, { archivedAt: archived ? new Date() : null });
      await audit(tx, {
        action: archived ? 'unit.archived' : 'unit.restored',
        entityType: 'unit',
        entityId: id,
      });
      return toUnit(after);
    });
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        await tx.delete(units).where(and(eq(units.tenantId, getTenantId()), eq(units.id, id)));
        await audit(tx, {
          action: 'unit.deleted',
          entityType: 'unit',
          entityId: id,
          changes: diff(snapshot(before), { code: null, name: null, decimals: null }),
        });
      });
    } catch (error) {
      // No "is it used?" query first: the FKs are the check, and they cannot miss a product
      // saved a moment ago
      if (
        isForeignKeyViolation(error, 'products_base_unit_fk') ||
        isForeignKeyViolation(error, 'product_units_unit_fk')
      ) {
        throw new AppError(409, 'unit_in_use', 'Products use this unit. Archive it instead.');
      }
      throw error;
    }
  }

  private async lock(tx: Transaction, id: string): Promise<UnitRow> {
    const [row] = await tx
      .select()
      .from(units)
      .where(and(eq(units.tenantId, getTenantId()), eq(units.id, id)))
      .for('update');
    if (!row) throw notFound('Unit');
    return row;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<UnitRow, 'code' | 'name' | 'decimals' | 'archivedAt'>>,
  ): Promise<UnitRow> {
    const [row] = await tx
      .update(units)
      .set({
        ...fields,
        version: sql`${units.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(units.tenantId, getTenantId()), eq(units.id, id)))
      .returning();
    if (!row) throw notFound('Unit');
    return row;
  }
}
