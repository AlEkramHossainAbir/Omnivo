import { Inject, Injectable } from '@nestjs/common';
import { tenants } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { seedTaxRates } from './seed-tax-rates.js';

// Gives the starting VAT rates (step 15a) to a workspace set up before step 15a. Migration 0026
// queues one 'workspace.tax_rates_requested' per such workspace; a new workspace gets them from the
// setup job. Both call seedTaxRates(), so the result is the same.
@Injectable()
export class TaxRatesHandler implements EventHandler<'workspace.tax_rates_requested'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // The setup job's lock: if both run for one workspace, they take turns and the second stops
      const [tenant] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new PermanentJobError('The workspace no longer exists');
      const made = await seedTaxRates(tx, tenantId);
      // The workspace has rates already: a second run of this job, or the setup job was first
      if (made === null) return;
      await audit(tx, {
        action: 'tax_rates.created',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({ rates: made }),
      });
    });
  }
}
