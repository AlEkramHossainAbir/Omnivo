import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditChanges,
  PermissionKey,
  PermissionMatrixInput,
  Role,
  RoleInput,
} from '@omnivo/contracts';
import {
  invitationRoles,
  invitations,
  membershipRoles,
  memberships,
  permissions,
  rolePermissions,
  roles,
} from '@omnivo/db';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { assertCanChangePermissions, loadRoles } from '../rbac/grants.js';
import { PermissionService } from '../rbac/permission.service.js';

type RoleRow = typeof roles.$inferSelect;

function snapshot(row: Pick<RoleRow, 'name' | 'description'>) {
  return { name: row.name, description: row.description };
}

function nameTaken(): AppError {
  return new AppError(409, 'role_name_taken', 'Another role already has this name.', {
    fieldErrors: { name: ['role_name_taken'] },
  });
}

// owner রোলের নাম, permission আর অস্তিত্ব — কোডের নিয়ম, ডেটার না (roles.kind দেখুন)
function ownerLocked(): AppError {
  return new AppError(409, 'owner_role_locked', 'The Owner role cannot be changed or deleted.');
}

function roleInUse(): AppError {
  return new AppError(
    409,
    'role_in_use',
    'Someone has this role or an open invitation gives it. Change that first.',
  );
}

@Injectable()
export class RolesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissionService: PermissionService,
  ) {}

  list(): Promise<Role[]> {
    return this.withTenant((tx) => this.readAll(tx));
  }

  async create(input: RoleInput): Promise<Role> {
    const tenantId = getTenantId();
    try {
      return await this.withTenant(async (tx) => {
        // নতুন রোল ফাঁকা — কোন permission পাবে সেটা matrix-এ টিক দিয়ে, যেখানে পাশাপাশি অন্য রোলগুলোও দেখা যায়
        const [row] = await tx
          .insert(roles)
          .values({ tenantId, ...input, createdBy: currentPrincipal().userId })
          .returning();
        if (!row) throw new Error('Role insert returned no row');
        await audit(tx, {
          action: 'role.created',
          entityType: 'role',
          entityId: row.id,
          changes: created(snapshot(row)),
        });
        return this.readOne(tx, row.id);
      });
    } catch (error) {
      // branches-এর মতো: unique index-ই শেষ কথা, আগে SELECT করে দেখা না (দুজন একসাথে একই নাম দিলে)
      if (isUniqueViolation(error, 'roles_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(id: string, input: RoleInput & { version: number }): Promise<Role> {
    const tenantId = getTenantId();
    try {
      const { role, holders } = await this.withTenant(async (tx) => {
        const { version, ...fields } = input;
        const before = await this.lock(tx, id);
        if (before.kind === 'owner') throw ownerLocked();
        if (before.version !== version) throw versionConflict();
        await tx
          .update(roles)
          .set({
            ...fields,
            version: sql`${roles.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(roles.tenantId, tenantId), eq(roles.id, id)));
        await audit(tx, {
          action: 'role.updated',
          entityType: 'role',
          entityId: id,
          changes: diff(snapshot(before), snapshot(fields)),
        });
        return { role: await this.readOne(tx, id), holders: await this.holders(tx, [id]) };
      });
      // নাম বদলালে /auth/me-র roles-এ নতুন নাম — cache-এ পুরনোটা থাকলে ১০ মিনিট পুরনো নাম দেখাত
      await this.permissionService.invalidate(tenantId, holders);
      return role;
    } catch (error) {
      if (isUniqueViolation(error, 'roles_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async remove(id: string, version: number): Promise<void> {
    const tenantId = getTenantId();
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.kind === 'owner') throw ownerLocked();
        if (before.version !== version) throw versionConflict();

        // কারো কাছে থাকলে বা খোলা invitation দিলে মোছা না — চুপচাপ মুছলে সেই লোকগুলোর অধিকার হঠাৎ
        // চলে যেত, আর invitation গ্রহণ করা লোক ঢুকে দেখত সে কিছুই পারে না
        const [members] = await tx
          .select({ total: count() })
          .from(membershipRoles)
          .innerJoin(
            memberships,
            and(
              eq(memberships.tenantId, membershipRoles.tenantId),
              eq(memberships.id, membershipRoles.membershipId),
            ),
          )
          .where(
            and(
              eq(membershipRoles.tenantId, tenantId),
              eq(membershipRoles.roleId, id),
              isNull(memberships.deletedAt),
            ),
          );
        const [open] = await tx
          .select({ total: count() })
          .from(invitationRoles)
          .innerJoin(
            invitations,
            and(
              eq(invitations.tenantId, invitationRoles.tenantId),
              eq(invitations.id, invitationRoles.invitationId),
            ),
          )
          .where(
            and(
              eq(invitationRoles.tenantId, tenantId),
              eq(invitationRoles.roleId, id),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          );
        if ((members?.total ?? 0) + (open?.total ?? 0) > 0) throw roleInUse();

        await tx
          .delete(rolePermissions)
          .where(and(eq(rolePermissions.tenantId, tenantId), eq(rolePermissions.roleId, id)));
        // পুরনো (গৃহীত/বাতিল) invitation-এর invitation_roles রো FK-এর cascade-এ যায়
        await tx.delete(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.id, id)));
        await audit(tx, {
          action: 'role.deleted',
          entityType: 'role',
          entityId: id,
          changes: diff(snapshot(before), { name: null, description: null }),
        });
      });
    } catch (error) {
      // গোনার পরে, মোছার আগে আরেকজন কাউকে এই রোল দিয়ে ফেলল — তার insert এই রোলের রো-তে FK-র lock
      // নেয়, তাই আমাদের DELETE তার commit পর্যন্ত অপেক্ষা করে তারপর FK-তে ভাঙে। শেষ পাহারা DB নিজে
      if (isForeignKeyViolation(error, 'membership_roles_role_fk')) throw roleInUse();
      throw error;
    }
  }

  async updateMatrix(input: PermissionMatrixInput): Promise<Role[]> {
    const tenantId = getTenantId();
    const access = await this.permissionService.ofCurrentUser();
    const ids = input.roles.map((change) => change.id);
    if (new Set(ids).size !== ids.length) {
      throw new AppError(400, 'invalid_input', 'Each role may appear only once.', {
        fieldErrors: { roles: ['invalid_value'] },
      });
    }

    const { list, holders } = await this.withTenant(async (tx) => {
      // সব রোল একসাথে lock, id-র ক্রমে — দুজন একসাথে দুটো ওভারল্যাপ করা matrix সেভ করলে একই ক্রমে
      // অপেক্ষা করে, একে অন্যকে আটকে deadlock হয় না (branches.archive-এর মতো)
      const locked = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.tenantId, tenantId), inArray(roles.id, ids)))
        .orderBy(asc(roles.id))
        .for('update');
      if (locked.length !== ids.length) throw notFound('Role');
      const current = await loadRoles(tx, tenantId, ids);
      const catalog = await tx
        .select({ id: permissions.id, key: permissions.key })
        .from(permissions);
      const idOf = new Map(catalog.map((row) => [row.key, row.id]));
      const permissionIds = (keys: PermissionKey[]) =>
        keys.flatMap((key) => {
          const permissionId = idOf.get(key);
          return permissionId === undefined ? [] : [permissionId];
        });

      const changed: string[] = [];
      for (const change of input.roles) {
        const row = locked.find((candidate) => candidate.id === change.id);
        const before = current.find((candidate) => candidate.id === change.id);
        if (!row || !before) throw notFound('Role');
        if (row.kind === 'owner') throw ownerLocked();
        if (row.version !== change.version) throw versionConflict();

        const next = new Set(change.permissions);
        const added = [...next].filter((key) => !before.permissions.includes(key));
        const removed = before.permissions.filter((key) => !next.has(key));
        // পাঠানো তালিকা আগেরটাই — version বাড়ানো বা audit-এ খালি "বদল" লেখার কারণ নেই
        if (added.length === 0 && removed.length === 0) continue;
        assertCanChangePermissions(access, [...added, ...removed]);

        if (removed.length > 0) {
          await tx
            .delete(rolePermissions)
            .where(
              and(
                eq(rolePermissions.tenantId, tenantId),
                eq(rolePermissions.roleId, row.id),
                inArray(rolePermissions.permissionId, permissionIds(removed)),
              ),
            );
        }
        if (added.length > 0) {
          await tx.insert(rolePermissions).values(
            permissionIds(added).map((permissionId) => ({
              tenantId,
              roleId: row.id,
              permissionId,
              createdBy: currentPrincipal().userId,
            })),
          );
        }
        await tx
          .update(roles)
          .set({ version: sql`${roles.version} + 1`, updatedBy: currentPrincipal().userId })
          .where(and(eq(roles.tenantId, tenantId), eq(roles.id, row.id)));

        // audit-এর ঘর = permission key, মান = আগে/পরে আছে কি না। viewer key-টা অনুবাদ করে দেখায়
        const changes: AuditChanges = {};
        for (const key of added) changes[key] = { from: false, to: true };
        for (const key of removed) changes[key] = { from: true, to: false };
        await audit(tx, {
          action: 'role.permissions_changed',
          entityType: 'role',
          entityId: row.id,
          changes,
        });
        changed.push(row.id);
      }

      return { list: await this.readAll(tx), holders: await this.holders(tx, changed) };
    });

    // commit-এর পরে: এই রোলগুলো যাদের আছে, তাদের পরের request-এই নতুন অধিকার
    await this.permissionService.invalidate(tenantId, holders);
    return list;
  }

  // এই রোলগুলো যাদের আছে (চালু সদস্য) — cache মোছার তালিকা
  private async holders(tx: Transaction, roleIds: readonly string[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const rows = await tx
      .selectDistinct({ userId: memberships.userId })
      .from(membershipRoles)
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, membershipRoles.tenantId),
          eq(memberships.id, membershipRoles.membershipId),
        ),
      )
      .where(
        and(
          eq(membershipRoles.tenantId, getTenantId()),
          inArray(membershipRoles.roleId, [...roleIds]),
          isNull(memberships.deletedAt),
        ),
      );
    return rows.map((row) => row.userId);
  }

  private async readOne(tx: Transaction, id: string): Promise<Role> {
    const role = (await this.readAll(tx)).find((candidate) => candidate.id === id);
    if (!role) throw notFound('Role');
    return role;
  }

  // পুরো তালিকা: রোল, প্রত্যেকের permission আর সদস্য-সংখ্যা। তিনটা query, রোলের সংখ্যা যা-ই হোক —
  // রোলপ্রতি আলাদা query (N+1) না
  private async readAll(tx: Transaction): Promise<Role[]> {
    const tenantId = getTenantId();
    const rows = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), isNull(roles.deletedAt)))
      // owner সবার আগে (matrix-এর প্রথম কলাম), বাকিগুলো নাম অনুযায়ী
      .orderBy(desc(sql`${roles.kind} = 'owner'`), asc(roles.name));
    const loaded = await loadRoles(
      tx,
      tenantId,
      rows.map((row) => row.id),
    );
    const counts = await tx
      .select({ roleId: membershipRoles.roleId, total: count() })
      .from(membershipRoles)
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, membershipRoles.tenantId),
          eq(memberships.id, membershipRoles.membershipId),
        ),
      )
      .where(and(eq(membershipRoles.tenantId, tenantId), isNull(memberships.deletedAt)))
      .groupBy(membershipRoles.roleId);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      kind: row.kind,
      permissions: loaded.find((role) => role.id === row.id)?.permissions ?? [],
      memberCount: counts.find((entry) => entry.roleId === row.id)?.total ?? 0,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  // tenant filter + RLS: অন্য টেন্যান্টের id দিলে "নেই" — 404, 403 না (branches-এর মতো)
  private async lock(tx: Transaction, id: string): Promise<RoleRow> {
    const [row] = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, getTenantId()), eq(roles.id, id), isNull(roles.deletedAt)))
      .for('update');
    if (!row) throw notFound('Role');
    return row;
  }
}
