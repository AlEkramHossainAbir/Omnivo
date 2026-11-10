import type { PermissionKey } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// Whether a member holds a permission now, read from the database in the caller's transaction. For
// the worker (step 21b): a job runs for someone, without their request, and the worker has no
// permission cache (it does not import InfraModule, worker.module.ts). The same rules as
// PermissionService.loadFromDb(): a removed member holds nothing, the owner role holds every key,
// another role holds its own keys.
export async function holdsPermission(
  tx: Transaction,
  userId: string,
  permission: PermissionKey,
): Promise<boolean> {
  const tenantId = getTenantId();
  const [row] = z.array(z.object({ held: z.boolean() })).parse(
    await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1
            FROM memberships m
            JOIN membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
                                    AND mr.deleted_at IS NULL
            JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.deleted_at IS NULL
           WHERE m.tenant_id = ${tenantId}::uuid AND m.user_id = ${userId}::uuid
             AND m.deleted_at IS NULL
             AND (r.kind = 'owner' OR EXISTS (
                   SELECT 1 FROM role_permissions rp
                     JOIN permissions p ON p.id = rp.permission_id
                    WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id
                      AND rp.deleted_at IS NULL AND p.key = ${permission}))
        ) AS held`),
  );
  return row?.held ?? false;
}
