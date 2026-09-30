import { Inject, Injectable } from '@nestjs/common';
import { isIndustry } from '@omnivo/contracts';
import { permissions, rolePermissions, roles, tenants } from '@omnivo/db';
import { and, eq, inArray } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';
import { INDUSTRY_TEMPLATES, type RoleTemplate } from './templates.js';

type Event = OutboxEvent<'workspace.setup_requested'>;

// Creates the template's roles and their permissions. A role whose name is already taken (the
// owner made an "Accountant" before the job ran) is left alone — ON CONFLICT DO NOTHING on the
// lower(name) index — and gets no permissions from us: it is the owner's role, not ours.
async function seedRoles(
  tx: Transaction,
  tenantId: string,
  templates: readonly RoleTemplate[],
): Promise<{ id: string; name: string }[]> {
  const inserted = await tx
    .insert(roles)
    .values(
      templates.map((role) => ({
        tenantId,
        name: role.name,
        description: role.description,
        kind: 'custom' as const,
      })),
    )
    .onConflictDoNothing()
    // Only the rows really inserted come back — the skipped names do not
    .returning({ id: roles.id, name: roles.name });

  const keys = [...new Set(templates.flatMap((role) => role.permissions))];
  if (inserted.length === 0 || keys.length === 0) return inserted;

  // permissions is the global catalog (no tenant, no RLS): key → id
  const catalog = await tx
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions)
    .where(inArray(permissions.key, keys));
  const idOf = new Map(catalog.map((row) => [row.key, row.id]));

  const links = inserted.flatMap((role) => {
    const template = templates.find((candidate) => candidate.name === role.name);
    return (template?.permissions ?? []).flatMap((key) => {
      const permissionId = idOf.get(key);
      return permissionId === undefined ? [] : [{ tenantId, roleId: role.id, permissionId }];
    });
  });
  if (links.length > 0) await tx.insert(rolePermissions).values(links);
  return inserted;
}

@Injectable()
export class ProvisioningHandler implements EventHandler<'workspace.setup_requested'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // One transaction for everything, so the job is idempotent in a simple way: either all of it
  // committed (then the status is 'ready' and a second run stops at the check), or none of it did
  // (then a second run starts from a clean slate). Nothing is ever half set up.
  async handle(event: Event): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // FOR UPDATE: two runs of this job at once (a stalled job restarted while the first is still
      // going) take turns. The second one waits, then sees 'ready' and stops.
      const [tenant] = await tx
        .select({ status: tenants.setupStatus, industry: tenants.industry })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new PermanentJobError('The workspace no longer exists');
      if (tenant.status === 'ready') return;
      // The column is plain text in the DB; a value outside the list is broken data, and running
      // the job again will not fix it
      if (tenant.industry === null || !isIndustry(tenant.industry)) {
        throw new PermanentJobError('The workspace has no known business type');
      }

      const industry = tenant.industry;
      const seeded = await seedRoles(tx, tenantId, INDUSTRY_TEMPLATES[industry].roles);
      await tx.update(tenants).set({ setupStatus: 'ready' }).where(eq(tenants.id, tenantId));
      // No actorUserId: the audit log shows "System" — the job did it, not a person
      await audit(tx, {
        action: 'workspace.provisioned',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({
          industry,
          roles: seeded.length === 0 ? null : seeded.map((role) => role.name).join(', '),
        }),
      });
      await notify(tx, {
        userId: event.payload.userId,
        type: 'workspace.ready',
        eventId: event.id,
      });
    });
  }

  // After the last retry: the wizard stops waiting and offers "Try again". Only from
  // 'provisioning' — if a later run already finished, 'ready' must stay.
  async onGiveUp(): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant((tx) =>
      tx
        .update(tenants)
        .set({ setupStatus: 'failed' })
        .where(and(eq(tenants.id, tenantId), eq(tenants.setupStatus, 'provisioning'))),
    );
  }
}
