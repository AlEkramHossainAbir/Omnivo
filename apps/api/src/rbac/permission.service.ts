import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Principal } from '@omnivo/auth';
import { isPermissionKey, PERMISSION_KEYS, type PermissionKey } from '@omnivo/contracts';
import { membershipRoles, memberships, permissions, rolePermissions, roles } from '@omnivo/db';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { accessRevoked } from '../common/http/app-error.js';
import { currentPrincipal, runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { REDIS, WITH_TENANT } from '../infra/tokens.js';

// invalidation ভুলে গেলেও ১০ মিনিটের বেশি পুরনো permission থাকবে না
const CACHE_TTL_SECONDS = 600;

// একজন সদস্য এই মুহূর্তে কী পারে। roles = নাম (UI-তে দেখানো), owner = owner রোল আছে কি না
// (শুধু owner-ই আরেকজনকে owner বানাতে বা owner থেকে সরাতে পারে)
export interface Access {
  roles: string[];
  permissions: PermissionKey[];
  owner: boolean;
}

// cache-এ যা থাকে তা বাইরের ডেটা (Redis) — পড়ার সময় schema দিয়ে যাচাই, cast না। আকার বদলালে
// (যেমন ধাপ ৬-এর শুধু string[]) parse ব্যর্থ হয় আর DB থেকে নতুন করে পড়া হয়
const cachedAccessSchema = z.object({
  roles: z.array(z.string()),
  permissions: z.array(z.enum(PERMISSION_KEYS)),
  owner: z.boolean(),
});

// system-design §৪.৫-এর key ফরম্যাট: প্রতিটা Redis key টেন্যান্ট দিয়ে শুরু
export function permissionCacheKey(tenantId: string, userId: string): string {
  return `t:${tenantId}:perm:${userId}`;
}

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
  ) {}

  // null = সদস্যপদ আর নেই (বাদ দেওয়া হয়েছে)। টোকেন তখনো ১৫ মিনিট বৈধ থাকতে পারে — তাই প্রতিটা
  // request-এ PermissionGuard এটা দেখে 401 দেয়, টোকেনের মেয়াদের ভরসায় বসে থাকে না
  async forPrincipal(principal: Principal): Promise<Access | null> {
    const key = permissionCacheKey(principal.tenantId, principal.userId);

    const cached = await this.readCache(key);
    if (cached) return cached;

    const access = await this.loadFromDb(principal.tenantId, principal.membershipId);
    // null cache করা হয় না: বাদ পড়া সদস্যের প্রতিটা request DB-তে যায়, কিন্তু সে ১৫ মিনিটের মধ্যে
    // লগআউট হয়ে যায়। আর আবার invite হয়ে ফিরলে পুরনো "নেই" ১০ মিনিট তাকে আটকে রাখত না
    if (access) await this.writeCache(key, access);
    return access;
  }

  // service-এর ভেতরে "যে ডাকছে সে কী পারে" (কাকে কোন রোল দিতে পারবে)। guard একটু আগেই একই জিনিস
  // পড়েছে, তাই এটা প্রায় সবসময় cache থেকে আসে
  async ofCurrentUser(): Promise<Access> {
    const access = await this.forPrincipal(currentPrincipal());
    if (!access) throw accessRevoked();
    return access;
  }

  // রোল বা permission বদলানোর প্রতিটা কোড এটা ডাকে — transaction commit হওয়ার পরে, আগে না। আগে মুছলে
  // commit-এর আগের মুহূর্তে আসা আরেকটা request পুরনো অধিকার আবার পড়ে ১০ মিনিটের জন্য cache করে ফেলত
  async invalidate(tenantId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await this.redis.del(...userIds.map((userId) => permissionCacheKey(tenantId, userId)));
    } catch (error) {
      // Redis বন্ধ = cache-ও পড়া যাচ্ছে না; ফিরলে TTL-এর মধ্যে পুরনো মান মুছে যাবে
      this.logger.warn(`permission cache invalidation failed: ${String(error)}`);
    }
  }

  private async loadFromDb(tenantId: string, membershipId: string): Promise<Access | null> {
    return runWithTenant(tenantId, () =>
      this.withTenant(async (tx) => {
        const [membership] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, tenantId),
              eq(memberships.id, membershipId),
              isNull(memberships.deletedAt),
            ),
          );
        if (!membership) return null;

        const roleRows = await tx
          .select({ id: roles.id, name: roles.name, kind: roles.kind })
          .from(membershipRoles)
          .innerJoin(
            roles,
            and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
          )
          .where(
            and(
              eq(membershipRoles.tenantId, tenantId),
              eq(membershipRoles.membershipId, membershipId),
              isNull(membershipRoles.deletedAt),
              isNull(roles.deletedAt),
            ),
          )
          .orderBy(asc(roles.name));

        const owner = roleRows.some((role) => role.kind === 'owner');
        // owner = catalog-এর সব key, কোড থেকে। তাই নতুন permission যোগ হলে কোনো backfill লাগে না
        if (owner) {
          return {
            roles: roleRows.map((role) => role.name),
            permissions: [...PERMISSION_KEYS].sort(),
            owner,
          };
        }

        const customIds = roleRows.map((role) => role.id);
        const keyRows =
          customIds.length === 0
            ? []
            : await tx
                .selectDistinct({ key: permissions.key })
                .from(rolePermissions)
                .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
                .where(
                  and(
                    eq(rolePermissions.tenantId, tenantId),
                    inArray(rolePermissions.roleId, customIds),
                    isNull(rolePermissions.deletedAt),
                  ),
                );
        return {
          roles: roleRows.map((role) => role.name),
          // DB-তে এমন key থাকতে পারে যা catalog থেকে সরে গেছে — সেটা আর কোনো guard চেনে না, বাদ
          permissions: keyRows
            .map((row) => row.key)
            .filter(isPermissionKey)
            .sort(),
          owner,
        };
      }),
    );
  }

  // Redis নষ্ট হলে request ব্যর্থ করার বদলে DB থেকে পড়া — cache শুধু গতি, সত্যের উৎস না
  private async readCache(key: string): Promise<Access | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      const parsed = cachedAccessSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      this.logger.warn(`permission cache read failed: ${String(error)}`);
      return null;
    }
  }

  private async writeCache(key: string, access: Access): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(access), 'EX', CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`permission cache write failed: ${String(error)}`);
    }
  }
}
