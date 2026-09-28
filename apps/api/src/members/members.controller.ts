import { Controller, Get, Inject } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { MemberListResponse } from '@omnivo/contracts';
import { membershipRoles, memberships, roles, users } from '@omnivo/db';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';

@Controller('members')
export class MembersController {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  @Get()
  @RequirePermission('core.user.read')
  list(): Promise<MemberListResponse> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // explicit tenant filter + RLS: কোডে filter ভুলে গেলেও RLS আটকাবে, আর উল্টোটাও
      const rows = await tx
        .select({
          membershipId: memberships.id,
          userId: users.id,
          fullName: users.fullName,
          email: users.email,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, tenantId), isNull(memberships.deletedAt)))
        .orderBy(asc(users.fullName));

      const roleRows = await tx
        .select({ membershipId: membershipRoles.membershipId, name: roles.name })
        .from(membershipRoles)
        .innerJoin(
          roles,
          and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
        )
        .where(
          and(
            eq(membershipRoles.tenantId, tenantId),
            isNull(membershipRoles.deletedAt),
            isNull(roles.deletedAt),
          ),
        );

      const rolesByMembership = new Map<string, string[]>();
      for (const row of roleRows) {
        rolesByMembership.set(row.membershipId, [
          ...(rolesByMembership.get(row.membershipId) ?? []),
          row.name,
        ]);
      }

      return {
        members: rows.map((row) => ({
          ...row,
          roles: rolesByMembership.get(row.membershipId) ?? [],
        })),
      };
    });
  }
}