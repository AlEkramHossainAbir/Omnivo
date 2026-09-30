import {
  isPermissionKey,
  PERMISSION_KEYS,
  type PermissionKey,
  type RoleKind,
} from '@omnivo/contracts';
import { permissions, rolePermissions, roles } from '@omnivo/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import type { Access } from './permission.service.js';

// একটা রোল আর সে যা দেয় — invite, সদস্যের রোল বদল আর matrix, তিন জায়গাতেই "এটা দেওয়ার অধিকার
// তোমার আছে কি না" মাপতে লাগে
export interface RoleGrant {
  id: string;
  name: string;
  kind: RoleKind;
  permissions: PermissionKey[];
}

// ids-এর রোলগুলো, permission সহ, নাম অনুযায়ী সাজানো। tenant filter + RLS: অন্য টেন্যান্টের রোলের id
// "নেই"-এর মতোই। একটাও না মিললে 400 — ফর্মের সেই ঘরে (roleIds), কারণ ভুলটা ক্লায়েন্টের পাঠানো তালিকায়
export async function loadRoles(
  tx: Transaction,
  tenantId: string,
  ids: readonly string[],
): Promise<RoleGrant[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await tx
    .select({ id: roles.id, name: roles.name, kind: roles.kind })
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), inArray(roles.id, unique), isNull(roles.deletedAt)))
    .orderBy(asc(roles.name));
  if (rows.length !== unique.length) {
    throw new AppError(400, 'invalid_input', 'One of the roles does not exist.', {
      fieldErrors: { roleIds: ['invalid_value'] },
    });
  }

  const keyRows = await tx
    .select({ roleId: rolePermissions.roleId, key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(
      and(
        eq(rolePermissions.tenantId, tenantId),
        inArray(rolePermissions.roleId, unique),
        isNull(rolePermissions.deletedAt),
      ),
    );

  return rows.map((row) => ({
    ...row,
    permissions:
      row.kind === 'owner'
        ? [...PERMISSION_KEYS].sort()
        : keyRows
            .filter((key) => key.roleId === row.id)
            .map((key) => key.key)
            .filter(isPermissionKey)
            .sort(),
  }));
}

// "নিজের চেয়ে বেশি অধিকার কাউকে দেওয়া যায় না" (privilege escalation বন্ধ)। নাহলে core.user.manage
// পাওয়া একজন store keeper নিজের বন্ধুকে — বা আরেকটা অ্যাকাউন্ট খুলে নিজেকেই — Accountant বানাত।
// owner রোল দেওয়া বা কেড়ে নেওয়া শুধু owner-ই পারে: সব permission থাকা custom রোলের কেউও না, কারণ
// owner-এর বাড়তি ক্ষমতা ("শেষ owner সরানো যায় না") permission-এ লেখা নেই
export function assertCanGrant(access: Access, granted: readonly RoleGrant[]): void {
  if (access.owner) return;
  for (const role of granted) {
    const allowed =
      role.kind !== 'owner' && role.permissions.every((key) => access.permissions.includes(key));
    if (!allowed) {
      throw new AppError(403, 'cannot_grant', `You can't give or take away the ${role.name} role.`);
    }
  }
}

// matrix-এ একটা টিক বসানো বা তোলা — শুধু নিজের আছে এমন permission-এর ঘরে
export function assertCanChangePermissions(access: Access, keys: readonly PermissionKey[]): void {
  if (access.owner) return;
  const missing = keys.filter((key) => !access.permissions.includes(key));
  if (missing.length > 0) {
    throw new AppError(403, 'cannot_grant', `You don't have ${missing.join(', ')} yourself.`);
  }
}
