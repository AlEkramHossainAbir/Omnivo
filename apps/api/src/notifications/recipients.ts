import type { PermissionKey } from '@omnivo/contracts';
import { membershipRoles, memberships, permissions, rolePermissions, roles } from '@omnivo/db';
import { and, eq, isNull, or } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// Step 28a: the members whose bell a background job rings: the owners, and everyone one of whose
// roles has the permission. The same query OrderConfirmedHandler (27a) and the POS handlers write
// out themselves; new handlers use this one. Distinct users: a member with two such roles hears
// once
export async function membersWhoMay(
  tx: Transaction,
  permission: PermissionKey,
): Promise<{ userId: string }[]> {
  const tenantId = getTenantId();
  return tx
    .selectDistinct({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(
      membershipRoles,
      and(
        eq(membershipRoles.tenantId, memberships.tenantId),
        eq(membershipRoles.membershipId, memberships.id),
        isNull(membershipRoles.deletedAt),
      ),
    )
    .innerJoin(
      roles,
      and(
        eq(roles.tenantId, membershipRoles.tenantId),
        eq(roles.id, membershipRoles.roleId),
        isNull(roles.deletedAt),
      ),
    )
    .leftJoin(
      rolePermissions,
      and(
        eq(rolePermissions.tenantId, roles.tenantId),
        eq(rolePermissions.roleId, roles.id),
        isNull(rolePermissions.deletedAt),
      ),
    )
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        isNull(memberships.deletedAt),
        or(eq(roles.kind, 'owner'), eq(permissions.key, permission)),
      ),
    );
}
