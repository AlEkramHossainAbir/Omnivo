import { Inject, Injectable } from '@nestjs/common';
import type { TaxRate, TaxRateInput, UpdateTaxRateInput } from '@omnivo/contracts';
import { taxRates } from '@omnivo/db';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type TaxRateRow = typeof taxRates.$inferSelect;

function toTaxRate(row: TaxRateRow): TaxRate {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    rate: row.rate,
    isDefault: row.isDefault,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshot(row: Pick<TaxRateRow, 'name' | 'kind' | 'rate' | 'isDefault'>) {
  return { name: row.name, kind: row.kind, rate: row.rate, isDefault: row.isDefault };
}

function nameTaken(): AppError {
  return new AppError(409, 'tax_rate_name_taken', 'Another VAT rate already has this name.', {
    fieldErrors: { name: ['tax_rate_name_taken'] },
  });
}

function defaultArchived(): AppError {
  return new AppError(
    409,
    'tax_rate_default_archived',
    'The default VAT rate cannot be archived. Make another rate the default first.',
    { fieldErrors: { isDefault: ['tax_rate_default_archived'] } },
  );
}

// The workspace's VAT rates (step 15a). Exactly one active rate is the default: the database
// allows at most one (tax_rates_tenant_default_idx), and this service makes sure there is always
// one — the default moves to another rate, it is never just switched off.
@Injectable()
export class TaxRatesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<TaxRate[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(taxRates)
        .where(eq(taxRates.tenantId, getTenantId()))
        // The default first, then the highest rate: the order of the pickers
        .orderBy(desc(taxRates.isDefault), desc(taxRates.rate), asc(taxRates.name));
      return rows.map(toTaxRate);
    });
  }

  async create(input: TaxRateInput): Promise<TaxRate> {
    try {
      return await this.withTenant(async (tx) => {
        await this.lockDefault(tx);
        const [current] = await tx
          .select({ id: taxRates.id })
          .from(taxRates)
          .where(and(eq(taxRates.tenantId, getTenantId()), eq(taxRates.isDefault, true)));
        // A workspace whose rates the worker has not made yet: its first rate is the default
        const isDefault = input.isDefault || !current;
        if (isDefault && current) await this.clearDefault(tx);
        const [row] = await tx
          .insert(taxRates)
          .values({
            tenantId: getTenantId(),
            name: input.name,
            kind: input.kind,
            rate: input.rate,
            isDefault,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Tax rate insert returned no row');
        await audit(tx, {
          action: 'tax_rate.created',
          entityType: 'tax_rate',
          entityId: row.id,
          changes: created(snapshot(row)),
        });
        return toTaxRate(row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'tax_rates_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdateTaxRateInput): Promise<TaxRate> {
    try {
      return await this.withTenant(async (tx) => {
        await this.lockDefault(tx);
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        if (before.isDefault && !input.isDefault) {
          // Which rate would products without their own rate use? The person picks it by making
          // that rate the default, which takes the flag off this one.
          throw new AppError(
            409,
            'tax_rate_default_needed',
            'Make another rate the default instead.',
            { fieldErrors: { isDefault: ['tax_rate_default_needed'] } },
          );
        }
        if (input.isDefault && before.archivedAt !== null) throw defaultArchived();
        if (input.isDefault && !before.isDefault) await this.clearDefault(tx);
        const after = await this.write(tx, id, {
          name: input.name,
          kind: input.kind,
          rate: input.rate,
          isDefault: input.isDefault,
        });
        await audit(tx, {
          action: 'tax_rate.updated',
          entityType: 'tax_rate',
          entityId: id,
          changes: diff(snapshot(before), snapshot(after)),
        });
        return toTaxRate(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'tax_rates_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  // Archived: hidden from the pickers. Products that chose it keep it, and documents already
  // written keep their own copy of the rate (step 15b).
  setArchived(id: string, version: number, archived: boolean): Promise<TaxRate> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) === archived) return toTaxRate(before);
      if (archived && before.isDefault) throw defaultArchived();
      const after = await this.write(tx, id, { archivedAt: archived ? new Date() : null });
      await audit(tx, {
        action: archived ? 'tax_rate.archived' : 'tax_rate.restored',
        entityType: 'tax_rate',
        entityId: id,
      });
      return toTaxRate(after);
    });
  }

  // Two saves that both move the default would each clear the old one and set their own; the
  // unique index would then refuse the second with a database error. With this lock they take
  // turns, and the second one sees the first one's default. Per workspace, for this transaction.
  private async lockDefault(tx: Transaction): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tax_rates_default:${getTenantId()}`}, 0))`,
    );
  }

  // Before the new default is written: the partial unique index is checked on every row, so for
  // a moment two defaults would be refused, even inside one transaction
  private async clearDefault(tx: Transaction): Promise<void> {
    await tx
      .update(taxRates)
      .set({
        isDefault: false,
        version: sql`${taxRates.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(taxRates.tenantId, getTenantId()), eq(taxRates.isDefault, true)));
  }

  private async lock(tx: Transaction, id: string): Promise<TaxRateRow> {
    const [row] = await tx
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.tenantId, getTenantId()), eq(taxRates.id, id)))
      .for('update');
    if (!row) throw notFound('VAT rate');
    return row;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<TaxRateRow, 'name' | 'kind' | 'rate' | 'isDefault' | 'archivedAt'>>,
  ): Promise<TaxRateRow> {
    const [row] = await tx
      .update(taxRates)
      .set({
        ...fields,
        version: sql`${taxRates.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(taxRates.tenantId, getTenantId()), eq(taxRates.id, id)))
      .returning();
    if (!row) throw notFound('VAT rate');
    return row;
  }
}
