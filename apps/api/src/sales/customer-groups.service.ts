import { Inject, Injectable } from '@nestjs/common';
import type { CustomerGroup, CustomerGroupInput } from '@omnivo/contracts';
import { customerGroups, parties } from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type GroupRow = typeof customerGroups.$inferSelect;

// Every customer in the group, archived ones too: they still hold the FK that stops a delete.
// The outer table by its name: Drizzle would print ${customerGroups.id} as a bare "id", which
// inside this subquery means the party's own id.
const customerCount = sql<number>`(
  SELECT count(*)::int FROM ${parties} p
   WHERE p.tenant_id = customer_groups.tenant_id AND p.customer_group_id = customer_groups.id
)`;

function toGroup(row: GroupRow, count: number): CustomerGroup {
  return {
    id: row.id,
    name: row.name,
    customerCount: count,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nameTaken(): AppError {
  return new AppError(409, 'customer_group_name_taken', 'Another group already has this name.', {
    fieldErrors: { name: ['customer_group_name_taken'] },
  });
}

// Dealer, Retailer, Corporate (step 15a). Deleted for real, and only while empty: a group is a
// label for filtering, with no history of its own worth keeping.
@Injectable()
export class CustomerGroupsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<CustomerGroup[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ group: customerGroups, customerCount })
        .from(customerGroups)
        .where(eq(customerGroups.tenantId, getTenantId()))
        .orderBy(asc(sql`lower(${customerGroups.name})`));
      return rows.map((row) => toGroup(row.group, row.customerCount));
    });
  }

  async create(input: CustomerGroupInput): Promise<CustomerGroup> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(customerGroups)
          .values({
            tenantId: getTenantId(),
            name: input.name,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Customer group insert returned no row');
        await audit(tx, {
          action: 'customer_group.created',
          entityType: 'customer_group',
          entityId: row.id,
          changes: created({ name: row.name }),
        });
        return toGroup(row, 0);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'customer_groups_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(
    id: string,
    input: CustomerGroupInput & { version: number },
  ): Promise<CustomerGroup> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        await tx
          .update(customerGroups)
          .set({
            name: input.name,
            version: sql`${customerGroups.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(customerGroups.tenantId, getTenantId()), eq(customerGroups.id, id)));
        await audit(tx, {
          action: 'customer_group.updated',
          entityType: 'customer_group',
          entityId: id,
          changes: diff({ name: before.name }, { name: input.name }),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'customer_groups_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        await tx
          .delete(customerGroups)
          .where(and(eq(customerGroups.tenantId, getTenantId()), eq(customerGroups.id, id)));
        await audit(tx, {
          action: 'customer_group.deleted',
          entityType: 'customer_group',
          entityId: id,
          changes: diff({ name: before.name }, { name: null }),
        });
      });
    } catch (error) {
      // No count first: the FK is the check, and it cannot miss a customer saved a moment ago
      if (isForeignKeyViolation(error, 'parties_customer_group_fk')) {
        throw new AppError(
          409,
          'customer_group_in_use',
          'Customers are in this group. Move them to another group first.',
        );
      }
      throw error;
    }
  }

  private async lock(tx: Transaction, id: string): Promise<GroupRow> {
    const [row] = await tx
      .select()
      .from(customerGroups)
      .where(and(eq(customerGroups.tenantId, getTenantId()), eq(customerGroups.id, id)))
      .for('update');
    if (!row) throw notFound('Customer group');
    return row;
  }

  private async read(tx: Transaction, id: string): Promise<CustomerGroup> {
    const [row] = await tx
      .select({ group: customerGroups, customerCount })
      .from(customerGroups)
      .where(and(eq(customerGroups.tenantId, getTenantId()), eq(customerGroups.id, id)));
    if (!row) throw notFound('Customer group');
    return toGroup(row.group, row.customerCount);
  }
}
