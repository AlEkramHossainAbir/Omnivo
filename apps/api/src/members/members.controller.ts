import { Controller, Inject } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
import { membershipRoles, memberships, roles, users } from '@omnivo/db';
import { z } from 'zod';

import { Endpoint } from '../common/http/endpoint.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';

type ListRoute = typeof routes.members.list;

@Controller()
export class MembersController {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  @Endpoint(routes.members.list)
  @RequirePermission('core.user.read')
  list({ query }: RouteInput<ListRoute>): Promise<RouteResponse<ListRoute>> {
    const tenantId = getTenantId();
    // cursor = [sort, শেষ রো-র নাম, শেষ রো-র id]। sort-টা literal দিয়ে যাচাই: "name"-এর cursor
    // "-name"-এ চালালে ভুল জায়গা থেকে পাতা শুরু হতো — চুপচাপ ভুল তালিকা না দিয়ে 400
    const after = decodeCursor(
      query.cursor,
      z.tuple([z.literal(query.sort), z.string(), z.uuid()]),
    );
    const descending = query.sort === '-name';
    const direction = descending ? desc : asc;

    return this.withTenant(async (tx) => {
      // keyset: (নাম, id) জোড়া দিয়ে তুলনা — শুধু নাম দিলে একই নামের দুজনের একজন বাদ পড়ত বা দুবার
      // আসত; id (uuidv7, অনন্য) টাই ভাঙে। ORDER BY-এর কলাম আর তুলনার কলাম হুবহু এক
      const position =
        after &&
        (descending
          ? sql`(${users.fullName}, ${memberships.id}) < (${after[1]}, ${after[2]})`
          : sql`(${users.fullName}, ${memberships.id}) > (${after[1]}, ${after[2]})`);

      const rows = await tx
        .select({
          membershipId: memberships.id,
          userId: users.id,
          fullName: users.fullName,
          email: users.email,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        // explicit tenant filter + RLS: কোডে filter ভুলে গেলেও RLS আটকাবে, আর উল্টোটাও
        .where(and(eq(memberships.tenantId, tenantId), isNull(memberships.deletedAt), position))
        .orderBy(direction(users.fullName), direction(memberships.id))
        .limit(query.limit + 1);

      const page = toPage(rows, query.limit, (last) => [
        query.sort,
        last.fullName,
        last.membershipId,
      ]);

      // রোল শুধু এই পাতার সদস্যদের — পুরো টেন্যান্টের না
      const ids = page.items.map((row) => row.membershipId);
      const roleRows =
        ids.length === 0
          ? []
          : await tx
              .select({ membershipId: membershipRoles.membershipId, name: roles.name })
              .from(membershipRoles)
              .innerJoin(
                roles,
                and(
                  eq(roles.tenantId, membershipRoles.tenantId),
                  eq(roles.id, membershipRoles.roleId),
                ),
              )
              .where(
                and(
                  eq(membershipRoles.tenantId, tenantId),
                  inArray(membershipRoles.membershipId, ids),
                  isNull(membershipRoles.deletedAt),
                  isNull(roles.deletedAt),
                ),
              )
              .orderBy(asc(roles.name));

      const rolesByMembership = new Map<string, string[]>();
      for (const row of roleRows) {
        rolesByMembership.set(row.membershipId, [
          ...(rolesByMembership.get(row.membershipId) ?? []),
          row.name,
        ]);
      }

      return {
        items: page.items.map((row) => ({
          ...row,
          roles: rolesByMembership.get(row.membershipId) ?? [],
        })),
        nextCursor: page.nextCursor,
      };
    });
  }
}
