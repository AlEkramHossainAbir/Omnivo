import type { PermissionKey } from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// Who holds a permission now, read from the database in the caller's transaction. For the worker
// (step 21b): a job runs for someone, without their request, and the worker has no permission
// cache (it does not import InfraModule, worker.module.ts). The same rules as
// PermissionService.loadFromDb(): a removed member holds nothing, the owner role holds every key,
// another role holds its own keys.

// The user ids of the members who hold it: the one query both functions below run, so the two can
// never disagree on the rules. userId narrows it to one person.
function holderIds(tenantId: string, permission: PermissionKey, userId: string | null): SQL {
  return sql`
    SELECT DISTINCT m.user_id
      FROM memberships m
      JOIN membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
                              AND mr.deleted_at IS NULL
      JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.deleted_at IS NULL
     WHERE m.tenant_id = ${tenantId}::uuid
       ${userId === null ? sql`` : sql`AND m.user_id = ${userId}::uuid`}
       AND m.deleted_at IS NULL
       AND (r.kind = 'owner' OR EXISTS (
             SELECT 1 FROM role_permissions rp
               JOIN permissions p ON p.id = rp.permission_id
              WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id
                AND rp.deleted_at IS NULL AND p.key = ${permission}))`;
}

export async function holdsPermission(
  tx: Transaction,
  userId: string,
  permission: PermissionKey,
): Promise<boolean> {
  const [row] = z
    .array(z.object({ held: z.boolean() }))
    .parse(
      await tx.execute(
        sql`SELECT EXISTS (${holderIds(getTenantId(), permission, userId)}) AS held`,
      ),
    );
  return row?.held ?? false;
}

// Step 21c: everyone who holds it, for the scheduled reports (who may get one, who is skipped)
export async function permissionHolders(
  tx: Transaction,
  permission: PermissionKey,
): Promise<Set<string>> {
  const rows = z
    .array(z.object({ user_id: z.uuid() }))
    .parse(await tx.execute(holderIds(getTenantId(), permission, null)));
  return new Set(rows.map((row) => row.user_id));
}
