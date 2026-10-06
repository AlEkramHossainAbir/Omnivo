import { Inject, Injectable } from '@nestjs/common';
import { isIndustry } from '@omnivo/contracts';
import { tenants } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { seedStockAccounts } from './seed-stock-accounts.js';
import { INDUSTRY_TEMPLATES } from './templates.js';

// Gives the stock accounts (step 14) to a workspace whose chart was made before step 14. Migration
// 0024 queues one 'workspace.stock_accounts_requested' per such workspace; a new workspace gets
// them from the setup job, a chart made by ChartHandler from that job. All three call
// seedStockAccounts(), so the result is the same.
@Injectable()
export class StockAccountsHandler implements EventHandler<'workspace.stock_accounts_requested'> {
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
      const chosen = await seedStockAccounts(tx, tenantId, INDUSTRY_TEMPLATES[industry]);
      // No chart (its own job will choose them), or chosen already (a second run of this job)
      if (chosen === null || chosen === 0) return;
      await audit(tx, {
        action: 'stock_accounts.created',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({ industry, uses: chosen }),
      });
    });
  }
}
