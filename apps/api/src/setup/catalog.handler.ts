import { Inject, Injectable } from '@nestjs/common';
import { isIndustry } from '@omnivo/contracts';
import { tenants } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { seedCatalog } from './seed-catalog.js';
import { INDUSTRY_TEMPLATES } from './templates.js';

// Gives units, product categories and custom fields to a workspace set up before step 12.
// Migration 0020 queues one 'workspace.catalog_requested' per such workspace; new workspaces get
// theirs from the setup job (ProvisioningHandler). Both call seedCatalog(): the same result.
@Injectable()
export class CatalogHandler implements EventHandler<'workspace.catalog_requested'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // The setup job's lock: if both run for one workspace, they take turns and the second stops
      const [tenant] = await tx
        .select({ industry: tenants.industry })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new PermanentJobError('The workspace no longer exists');
      const industry =
        tenant.industry !== null && isIndustry(tenant.industry) ? tenant.industry : 'other';
      const seeded = await seedCatalog(tx, tenantId, INDUSTRY_TEMPLATES[industry].catalog);
      // Already there: a second run of this job, or the setup job was first
      if (seeded === null) return;
      await audit(tx, {
        action: 'workspace.catalog_created',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({ industry, ...seeded }),
      });
    });
  }
}
