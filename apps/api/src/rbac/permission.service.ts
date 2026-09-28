import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Principal } from '@omnivo/auth';
import { membershipRoles, permissions, rolePermissions, roles } from '@omnivo/db';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { REDIS, WITH_TENANT } from '../infra/tokens.js';

// invalidation ভুলে গেলেও ১০ মিনিটের বেশি পুরনো permission থাকবে না
const CACHE_TTL_SECONDS = 600;

const cachedPermissionsSchema = z.array(z.string());

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

  async forPrincipal(principal: Principal): Promise<ReadonlySet<string>> {
    const key = permissionCacheKey(principal.tenantId, principal.userId);

    const cached = await this.readCache(key);
    if (cached) return new Set(cached);

    const keys = await this.loadFromDb(principal.tenantId, principal.membershipId);
    await this.writeCache(key, keys);
    return new Set(keys);
  }

  // রোল/permission বদলানোর কোড (ধাপ ৭) এটা ডাকবে
  async invalidate(tenantId: string, userId: string): Promise<void> {
    await this.redis.del(permissionCacheKey(tenantId, userId));
  }

  private async loadFromDb(tenantId: string, membershipId: string): Promise<string[]> {
    const rows = await runWithTenant(tenantId, () =>
      this.withTenant((tx) =>
        tx
          .selectDistinct({ key: permissions.key })
          .from(membershipRoles)
          .innerJoin(
            roles,
            and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
          )
          .innerJoin(
            rolePermissions,
            and(eq(rolePermissions.tenantId, roles.tenantId), eq(rolePermissions.roleId, roles.id)),
          )
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(
            and(
              eq(membershipRoles.tenantId, tenantId),
              eq(membershipRoles.membershipId, membershipId),
              isNull(membershipRoles.deletedAt),
              isNull(roles.deletedAt),
              isNull(rolePermissions.deletedAt),
            ),
          ),
      ),
    );
    return rows.map((row) => row.key).sort();
  }

  // Redis নষ্ট হলে request ব্যর্থ করার বদলে DB থেকে পড়া — cache শুধু গতি, সত্যের উৎস না
  private async readCache(key: string): Promise<string[] | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      const parsed = cachedPermissionsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      this.logger.warn(`permission cache read failed: ${String(error)}`);
      return null;
    }
  }

  private async writeCache(key: string, keys: string[]): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(keys), 'EX', CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`permission cache write failed: ${String(error)}`);
    }
  }
}