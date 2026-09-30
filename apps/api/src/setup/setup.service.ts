import { Inject, Injectable } from '@nestjs/common';
import type { Industry, Setup, SetupStatus } from '@omnivo/contracts';
import { tenants } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// The business type is picked once. Changing it later would mean undoing a template (roles now, a
// chart of accounts with posted entries later) — that is a support task, not a button.
function setupStarted(): AppError {
  return new AppError(409, 'setup_started', 'The workspace setup has already started.');
}

function setupNotFailed(): AppError {
  return new AppError(409, 'setup_not_failed', 'Only a failed setup can be retried.');
}

@Injectable()
export class SetupService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  get(): Promise<Setup> {
    return this.withTenant((tx) => this.read(tx));
  }

  // The API does only the quick part: record the choice and queue the work. The response comes
  // back in milliseconds, whatever the template holds (a chart of accounts from step 9 is ~150 rows).
  start(industry: Industry): Promise<Setup> {
    return this.withTenant(async (tx) => {
      const current = await this.lock(tx);
      // Two owners pressing Continue at once: the lock makes the second wait, and then it sees
      // 'provisioning' and gets 409 — one job, one industry
      if (current.status !== 'pending') throw setupStarted();
      await this.moveTo(tx, 'provisioning', industry);
      await audit(tx, {
        action: 'workspace.setup_started',
        entityType: 'workspace',
        entityId: getTenantId(),
        changes: created({ industry }),
      });
      // Same transaction: if anything above fails, no job is queued; once it commits, the job
      // will run even if this process dies right after
      await emit(tx, 'workspace.setup_requested', { userId: currentPrincipal().userId });
      return { status: 'provisioning', industry };
    });
  }

  // The job is idempotent, so running it again is always safe. A new event, not the old job: the
  // old one has used up its retries.
  retry(): Promise<Setup> {
    return this.withTenant(async (tx) => {
      const current = await this.lock(tx);
      if (current.status !== 'failed') throw setupNotFailed();
      await this.moveTo(tx, 'provisioning');
      await emit(tx, 'workspace.setup_requested', { userId: currentPrincipal().userId });
      return { status: 'provisioning', industry: current.industry };
    });
  }

  private async read(tx: Transaction): Promise<Setup> {
    const [row] = await tx
      .select({ status: tenants.setupStatus, industry: tenants.industry })
      .from(tenants)
      .where(eq(tenants.id, getTenantId()));
    if (!row) throw notFound('Workspace');
    return row;
  }

  // tenants has no RLS; the id comes from the token, never from the request body
  private async lock(tx: Transaction): Promise<Setup> {
    const [row] = await tx
      .select({ status: tenants.setupStatus, industry: tenants.industry })
      .from(tenants)
      .where(eq(tenants.id, getTenantId()))
      .for('update');
    if (!row) throw notFound('Workspace');
    return row;
  }

  private async moveTo(tx: Transaction, status: SetupStatus, industry?: Industry): Promise<void> {
    await tx
      .update(tenants)
      .set({ setupStatus: status, ...(industry !== undefined && { industry }) })
      .where(eq(tenants.id, getTenantId()));
  }
}
