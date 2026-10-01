import { Inject, Injectable } from '@nestjs/common';
import { isIndustry } from '@omnivo/contracts';
import { tenants } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { seedChart } from './seed-chart.js';
import { INDUSTRY_TEMPLATES } from './templates.js';

// Gives a chart of accounts to a workspace that was set up before step 9. Migration 0014 queues
// one 'workspace.chart_requested' per such workspace; new workspaces get their chart from the
// setup job instead (ProvisioningHandler). Both use seedChart(), so the result is the same.
@Injectable()
export class ChartHandler implements EventHandler<'workspace.chart_requested'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // The same lock as the setup job. If both run for one workspace (its failed setup is retried
      // while this event waits), they take turns, and the second one finds a chart and stops.
      const [tenant] = await tx
        .select({ industry: tenants.industry })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new PermanentJobError('The workspace no longer exists');

      // Workspaces from before step 8 never picked a business type: they get the general chart
      const industry =
        tenant.industry !== null && isIndustry(tenant.industry) ? tenant.industry : 'other';
      const accounts = await seedChart(tx, tenantId, INDUSTRY_TEMPLATES[industry].chart);
      // Already had a chart: a second run of this job, or the setup job was first
      if (accounts === 0) return;
      // No actorUserId: the audit log shows "System"
      await audit(tx, {
        action: 'workspace.chart_created',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({ industry, accounts }),
      });
    });
  }
}
