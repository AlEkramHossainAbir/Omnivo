import { Inject, Injectable } from '@nestjs/common';
import type { Member, MemberPage, MemberSort, RoleRef } from '@omnivo/contracts';
import { membershipRoles, memberships, roles, users } from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { assertCanGrant, loadRoles, type RoleGrant } from '../rbac/grants.js';
import { PermissionService } from '../rbac/permission.service.js';

interface MemberRow {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  version: number;
  joinedAt: Date;
}

const memberColumns = {
  membershipId: memberships.id,
  userId: users.id,
  fullName: users.fullName,
  email: users.email,
  version: memberships.version,
  joinedAt: memberships.createdAt,
};

// audit-এ রোলের তালিকা একটা লেখা হিসেবে ("Accountant, Store keeper") — audit-এর মান সরল হতেই হবে
function names(list: readonly { name: string }[]): string | null {
  return list.length === 0 ? null : list.map((role) => role.name).join(', ');
}

// নিজের রোল বদলানো বা নিজেকে বাদ দেওয়া বন্ধ: ভুল করে নিজেকে লক-আউট করা, আর "নিজেকে বড় রোল দেওয়া"
// — দুটোর পথই এক জায়গায় বন্ধ। নিজের অধিকার বদলাতে আরেকজন অ্যাডমিন লাগে
function ownMembership(): AppError {
  return new AppError(
    409,
    'own_membership',
    "You can't change your own roles or remove yourself. Ask another admin.",
  );
}

@Injectable()
export class MembersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissionService: PermissionService,
  ) {}

  list(query: {
    sort: MemberSort;
    limit: number;
    cursor?: string | undefined;
  }): Promise<MemberPage> {
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
        .select(memberColumns)
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
      return { items: await this.withRoles(tx, page.items), nextCursor: page.nextCursor };
    });
  }

  async updateRoles(membershipId: string, roleIds: string[], version: number): Promise<Member> {
    const tenantId = getTenantId();
    const actor = currentPrincipal();
    const access = await this.permissionService.ofCurrentUser();

    const member = await this.withTenant(async (tx) => {
      const before = await this.lock(tx, membershipId);
      if (before.userId === actor.userId) throw ownMembership();
      if (before.version !== version) throw versionConflict();

      const current = await this.rolesOf(tx, membershipId);
      const next = await loadRoles(tx, tenantId, roleIds);
      const added = next.filter((role) => !current.some((had) => had.id === role.id));
      const removed = current.filter((had) => !next.some((role) => role.id === had.id));
      // যা দেওয়া হচ্ছে আর যা কেড়ে নেওয়া হচ্ছে — দুটোই নিজের সীমার ভেতরে হতে হবে
      assertCanGrant(access, [...added, ...removed]);
      if (removed.some((role) => role.kind === 'owner')) {
        await this.assertAnotherOwner(tx, membershipId);
      }

      if (removed.length > 0) {
        await tx.delete(membershipRoles).where(
          and(
            eq(membershipRoles.tenantId, tenantId),
            eq(membershipRoles.membershipId, membershipId),
            inArray(
              membershipRoles.roleId,
              removed.map((role) => role.id),
            ),
          ),
        );
      }
      if (added.length > 0) {
        await tx.insert(membershipRoles).values(
          added.map((role) => ({
            tenantId,
            membershipId,
            roleId: role.id,
            createdBy: actor.userId,
          })),
        );
      }
      // রোল আলাদা টেবিলে, কিন্তু version সদস্যপদের — "এই মানুষের অধিকার" একটা জিনিস হিসেবে বদলায়
      await this.bump(tx, membershipId);
      if (added.length > 0 || removed.length > 0) {
        await audit(tx, {
          action: 'member.roles_changed',
          entityType: 'member',
          entityId: membershipId,
          changes: { roles: { from: names(current), to: names(next) } },
        });
      }
      const [row] = await this.withRoles(tx, [await this.lock(tx, membershipId)]);
      if (!row) throw notFound('Member');
      return row;
    });

    // commit-এর পরে (PermissionService.invalidate দেখুন) — তার পরের request-এই নতুন অধিকার
    await this.permissionService.invalidate(tenantId, [member.userId]);
    return member;
  }

  async remove(membershipId: string, version: number): Promise<void> {
    const tenantId = getTenantId();
    const actor = currentPrincipal();
    const access = await this.permissionService.ofCurrentUser();

    const userId = await this.withTenant(async (tx) => {
      const before = await this.lock(tx, membershipId);
      if (before.userId === actor.userId) throw ownMembership();
      if (before.version !== version) throw versionConflict();

      const current = await this.rolesOf(tx, membershipId);
      // বাদ দেওয়া মানে তার সব রোল কেড়ে নেওয়া — তাই রোল বদলানোর একই নিয়ম: store keeper একজন
      // Accountant-কে বাদ দিতে পারে না, আর owner-কে বাদ দিতে পারে শুধু আরেকজন owner
      assertCanGrant(access, current);
      if (current.some((role) => role.kind === 'owner')) {
        await this.assertAnotherOwner(tx, membershipId);
      }

      await tx
        .delete(membershipRoles)
        .where(
          and(
            eq(membershipRoles.tenantId, tenantId),
            eq(membershipRoles.membershipId, membershipId),
          ),
        );
      // সদস্যপদ মোছা না, বন্ধ: তার আগের কাজের audit আর created_by অক্ষত থাকে, আর unique
      // (tenant_id, user_id) index-এর কারণে আবার invite করলে এই রো-টাই ফিরে আসে (invitations.service.ts)
      await tx
        .update(memberships)
        .set({
          deletedAt: new Date(),
          version: sql`${memberships.version} + 1`,
          updatedBy: actor.userId,
        })
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));
      await audit(tx, {
        action: 'member.removed',
        entityType: 'member',
        entityId: membershipId,
        changes: {
          email: { from: before.email, to: null },
          roles: { from: names(current), to: null },
        },
      });
      return before.userId;
    });

    // cache মুছলে তার পরের request-এ PermissionGuard DB থেকে পড়ে দেখে সদস্যপদ নেই → 401 access_revoked।
    // টোকেনের বাকি ১৫ মিনিটের অপেক্ষা নেই
    await this.permissionService.invalidate(tenantId, [userId]);
  }

  // "অন্তত একজন owner থাকবে"। শুধু গুনে দেখা যথেষ্ট না (write skew — branches.archive-এর মতো): দুই
  // owner একসাথে একে অন্যকে সরালে দুজনেই "আরেকজন তো আছে" দেখত, আর owner থাকত শূন্য। তাই সব owner-এর
  // membership_roles রো lock, id-র ক্রমে। দ্বিতীয়জন প্রথমজনের commit পর্যন্ত অপেক্ষা করে, তারপর Postgres
  // রো-গুলো আবার দেখে — প্রথমজনের মোছা রো আর থাকে না, তাই সে ঠিক হিসাবটা পায়
  private async assertAnotherOwner(tx: Transaction, excluding: string): Promise<void> {
    const owners = await tx
      .select({ membershipId: membershipRoles.membershipId })
      .from(membershipRoles)
      .innerJoin(
        roles,
        and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
      )
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
          eq(roles.kind, 'owner'),
          isNull(memberships.deletedAt),
        ),
      )
      .orderBy(asc(membershipRoles.id))
      .for('update', { of: membershipRoles });
    if (!owners.some((owner) => owner.membershipId !== excluding)) {
      throw new AppError(409, 'last_owner', 'A workspace needs at least one owner.');
    }
  }

  private async rolesOf(tx: Transaction, membershipId: string): Promise<RoleGrant[]> {
    const rows = await tx
      .select({ roleId: membershipRoles.roleId })
      .from(membershipRoles)
      .where(
        and(
          eq(membershipRoles.tenantId, getTenantId()),
          eq(membershipRoles.membershipId, membershipId),
          isNull(membershipRoles.deletedAt),
        ),
      );
    return loadRoles(
      tx,
      getTenantId(),
      rows.map((row) => row.roleId),
    );
  }

  // শুধু চালু সদস্য। FOR UPDATE শুধু memberships-এর রো-তে — users global টেবিল, সেটা আটকানোর কারণ নেই
  private async lock(tx: Transaction, membershipId: string): Promise<MemberRow> {
    const [row] = await tx
      .select(memberColumns)
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, getTenantId()),
          eq(memberships.id, membershipId),
          isNull(memberships.deletedAt),
        ),
      )
      .for('update', { of: memberships });
    if (!row) throw notFound('Member');
    return row;
  }

  private async bump(tx: Transaction, membershipId: string): Promise<void> {
    await tx
      .update(memberships)
      .set({ version: sql`${memberships.version} + 1`, updatedBy: currentPrincipal().userId })
      .where(and(eq(memberships.tenantId, getTenantId()), eq(memberships.id, membershipId)));
  }

  // রোল শুধু এই সদস্যদের — পুরো টেন্যান্টের না
  private async withRoles(tx: Transaction, rows: readonly MemberRow[]): Promise<Member[]> {
    const ids = rows.map((row) => row.membershipId);
    const roleRows =
      ids.length === 0
        ? []
        : await tx
            .select({
              membershipId: membershipRoles.membershipId,
              id: roles.id,
              name: roles.name,
            })
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
                eq(membershipRoles.tenantId, getTenantId()),
                inArray(membershipRoles.membershipId, ids),
                isNull(membershipRoles.deletedAt),
                isNull(roles.deletedAt),
              ),
            )
            .orderBy(asc(roles.name));

    const rolesByMembership = new Map<string, RoleRef[]>();
    for (const { membershipId, ...role } of roleRows) {
      rolesByMembership.set(membershipId, [...(rolesByMembership.get(membershipId) ?? []), role]);
    }
    return rows.map((row) => ({
      ...row,
      roles: rolesByMembership.get(row.membershipId) ?? [],
      joinedAt: row.joinedAt.toISOString(),
    }));
  }
}
