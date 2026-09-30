import { Inject, Injectable } from '@nestjs/common';
import type { Auth, IssuedTokens } from '@omnivo/auth';
import {
  type AcceptInvitationInput,
  type CreateInvitationInput,
  type Invitation,
  type InvitationDelivery,
  INVITATION_TTL_DAYS,
  type InvitationPreview,
  type RoleRef,
} from '@omnivo/contracts';
import {
  type Db,
  invitationRoles,
  invitations,
  membershipRoles,
  memberships,
  roles,
  tenants,
  users,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import { AuthService } from '../auth/auth.service.js';
import { audit, created } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { currentPrincipal, getTenantId, runWithTenant } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { AUTH, DB, WITH_TENANT } from '../infra/tokens.js';
import { assertCanGrant, loadRoles } from '../rbac/grants.js';
import { PermissionService } from '../rbac/permission.service.js';
import { hashInvitationToken } from './invitation-token.js';

type InvitationRow = typeof invitations.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

function expiry(): Date {
  return new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS);
}

// খোলা = গৃহীত বা বাতিল না, আর মেয়াদও আছে
function isUsable(row: InvitationRow): boolean {
  return row.acceptedAt === null && row.revokedAt === null && row.expiresAt > new Date();
}

// The email's state, from the two times the worker sets
function deliveryOf(row: Pick<InvitationRow, 'sentAt' | 'sendFailedAt'>): InvitationDelivery {
  if (row.sentAt !== null) return 'sent';
  return row.sendFailedAt !== null ? 'failed' : 'sending';
}

function names(list: readonly { name: string }[]): string | null {
  return list.length === 0 ? null : list.map((role) => role.name).join(', ');
}

// লিংক ভুল, পুরনো, বাতিল বা আগেই ব্যবহার করা — সবগুলো একই উত্তর। কোনটা হয়েছে বলে দিলে অনুমান করা
// token-এর অবস্থা জানা যেত; আসল মানুষের জন্য সমাধান একটাই: নতুন লিংক চাওয়া
function invitationInvalid(): AppError {
  return new AppError(
    404,
    'invitation_invalid',
    'This invitation link is not valid any more. Ask for a new one.',
  );
}

function alreadyMember(): AppError {
  return new AppError(409, 'already_member', 'This person is already a member.', {
    fieldErrors: { email: ['already_member'] },
  });
}

function alreadyInvited(): AppError {
  return new AppError(409, 'already_invited', 'This person already has an open invitation.', {
    fieldErrors: { email: ['already_invited'] },
  });
}

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly authService: AuthService,
    private readonly permissionService: PermissionService,
  ) {}

  list(): Promise<Invitation[]> {
    return this.withTenant((tx) => this.readOpen(tx));
  }

  async create(input: CreateInvitationInput): Promise<Invitation> {
    const tenantId = getTenantId();
    const actor = currentPrincipal();
    const access = await this.permissionService.ofCurrentUser();

    try {
      return await this.withTenant(async (tx) => {
        const granted = await loadRoles(tx, tenantId, input.roleIds);
        // invite = ভবিষ্যতে রোল দেওয়া — তাই এখনই একই নিয়ম (grants.ts)
        assertCanGrant(access, granted);

        const [member] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.tenantId, tenantId),
              eq(users.email, input.email),
              isNull(memberships.deletedAt),
            ),
          );
        if (member) throw alreadyMember();

        // একই ইমেইলের মেয়াদ পেরোনো খোলা invitation বন্ধ করা — নাহলে partial unique index নতুনটা আটকাত,
        // আর admin-কে আগে পুরনোটা হাতে বাতিল করতে হতো। মেয়াদ আছে এমনটা থাকলে index-ই 409 দেয়
        await tx
          .update(invitations)
          .set({
            revokedAt: new Date(),
            version: sql`${invitations.version} + 1`,
            updatedBy: actor.userId,
          })
          .where(
            and(
              eq(invitations.tenantId, tenantId),
              eq(invitations.email, input.email),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
              lte(invitations.expiresAt, new Date()),
            ),
          );

        const [row] = await tx
          .insert(invitations)
          // No token yet: the worker makes it right before sending (tokenHash stays NULL until then)
          .values({
            tenantId,
            email: input.email,
            expiresAt: expiry(),
            createdBy: actor.userId,
          })
          .returning({ id: invitations.id });
        if (!row) throw new Error('Invitation insert returned no row');
        await tx.insert(invitationRoles).values(
          granted.map((role) => ({
            tenantId,
            invitationId: row.id,
            roleId: role.id,
            createdBy: actor.userId,
          })),
        );
        await audit(tx, {
          action: 'member.invited',
          entityType: 'invitation',
          entityId: row.id,
          changes: created({ email: input.email, roles: names(granted) }),
        });
        // The email goes out from the worker a moment after this commits. The answer below says
        // "sending"; the team page polls until it turns into "sent" or "failed".
        await emit(tx, 'invitation.issued', { invitationId: row.id, actorUserId: actor.userId });
        const [invitation] = await this.readOpen(tx, [row.id]);
        if (!invitation) throw notFound('Invitation');
        return invitation;
      });
    } catch (error) {
      // দুজন admin একসাথে একই ইমেইল — partial unique index একজনকে আটকায় (আগে SELECT করে দেখা না)
      if (isUniqueViolation(error, 'invitations_tenant_email_open_idx')) throw alreadyInvited();
      throw error;
    }
  }

  // নতুন token (পুরনো লিংক সাথে সাথে অচল), নতুন মেয়াদ, আবার ইমেইল। ইমেইল হারানো, মেয়াদ পেরোনো বা
  // "পাঠানো হয়নি" — তিনটারই এক সমাধান
  async resend(id: string, version: number): Promise<Invitation> {
    const tenantId = getTenantId();
    const actor = currentPrincipal();
    const access = await this.permissionService.ofCurrentUser();

    return this.withTenant(async (tx) => {
      const before = await this.lockOpen(tx, id);
      if (before.version !== version) throw versionConflict();
      // আবার পাঠানো = আবার রোল দেওয়ার প্রস্তাব; যে পাঠাচ্ছে তার সীমায় থাকতে হবে
      assertCanGrant(access, await loadRoles(tx, tenantId, await this.roleIdsOf(tx, id)));
      await tx
        .update(invitations)
        // tokenHash NULL: the old link stops working now, not when the new email arrives.
        // sentAt and sendFailedAt NULL: the state goes back to "sending"
        .set({
          tokenHash: null,
          expiresAt: expiry(),
          sentAt: null,
          sendFailedAt: null,
          version: sql`${invitations.version} + 1`,
          updatedBy: actor.userId,
        })
        .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, id)));
      await audit(tx, {
        action: 'member.invitation_resent',
        entityType: 'invitation',
        entityId: id,
        // নতুন লিংক কাকে গেল — viewer-এ "Email: — → nasrin@…"
        changes: created({ email: before.email }),
      });
      await emit(tx, 'invitation.issued', { invitationId: id, actorUserId: actor.userId });
      const [invitation] = await this.readOpen(tx, [id]);
      if (!invitation) throw notFound('Invitation');
      return invitation;
    });
  }

  async revoke(id: string, version: number): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const before = await this.lockOpen(tx, id);
      if (before.version !== version) throw versionConflict();
      await tx
        .update(invitations)
        .set({
          revokedAt: new Date(),
          version: sql`${invitations.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, id)));
      await audit(tx, {
        action: 'member.invitation_revoked',
        entityType: 'invitation',
        entityId: id,
        changes: { email: { from: before.email, to: null } },
      });
    });
  }

  // public: লিংক খুললে "কোন workspace, কে ডেকেছে"
  async lookup(token: string): Promise<InvitationPreview> {
    const invitation = await this.findByToken(token);
    // tenants আর users-এ RLS নেই (global টেবিল) — টেন্যান্ট জানার আগেই পড়া যায়
    const [tenant] = await this.db
      .select({ name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(and(eq(tenants.id, invitation.tenantId), isNull(tenants.deletedAt)));
    if (!tenant) throw invitationInvalid();
    const [inviter] =
      invitation.createdBy === null
        ? []
        : await this.db
            .select({ fullName: users.fullName })
            .from(users)
            .where(eq(users.id, invitation.createdBy));
    const [account] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invitation.email));

    return {
      workspace: tenant,
      email: invitation.email,
      invitedBy: inviter?.fullName ?? null,
      accountExists: account !== undefined,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  // public: অ্যাকাউন্ট (নতুন বা পুরনো) → সদস্যপদ → session। Better Auth-এর ইউজার আর আমাদের সদস্যপদ আলাদা
  // transaction-এ (সাইনআপের মতোই), তাই মাঝপথে ব্যর্থ হলে হাতে ফেরানো
  async accept(input: AcceptInvitationInput): Promise<IssuedTokens> {
    const invitation = await this.findByToken(input.token);

    // ইমেইল invitation থেকে, ক্লায়েন্ট থেকে না — অন্য কারো অ্যাকাউন্টে invitation বসানোর উপায় নেই
    const identity =
      input.account === 'new'
        ? await this.authService.createAccount({
            email: invitation.email,
            fullName: input.fullName,
            password: input.password,
          })
        : await this.authService.verifyPassword({
            email: invitation.email,
            password: input.password,
            keepSignedIn: true,
          });

    try {
      await runWithTenant(invitation.tenantId, () =>
        this.withTenant((tx) => this.join(tx, invitation.id, identity.userId)),
      );
    } catch (error) {
      // যেমন: লিংক খোলা আর "Join" চাপার মাঝে admin invitation বাতিল করেছে। নতুন অ্যাকাউন্ট সদস্যপদ
      // ছাড়া পড়ে থাকলে ওই ইমেইলে আর সাইনআপও করা যেত না ("email taken"); পুরনো অ্যাকাউন্টের session শুধু বন্ধ
      if (input.account === 'new') await this.auth.deleteUser(identity.userId);
      else await this.auth.revokeSession(identity.sessionId);
      throw error;
    }

    await this.permissionService.invalidate(invitation.tenantId, [identity.userId]);
    return this.authService.startSessionIn(identity, invitation.tenantId);
  }

  // সদস্যপদ তৈরি বা ফেরানো, রোল বসানো, invitation বন্ধ — এক transaction-এ, টেন্যান্টের context-এ
  private async join(tx: Transaction, invitationId: string, userId: string): Promise<void> {
    const tenantId = getTenantId();
    // FOR UPDATE: একই লিংকে দুবার একসাথে "Join" (দুই ট্যাব) — দ্বিতীয়টা প্রথমটার commit পর্যন্ত অপেক্ষা
    // করে, তারপর acceptedAt দেখে থামে; দুটো সদস্যপদ বা দুবার রোল না
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, invitationId)))
      .for('update');
    if (!invitation || !isUsable(invitation)) throw invitationInvalid();

    const [existing] = await tx
      .select({ id: memberships.id, deletedAt: memberships.deletedAt })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .for('update');

    let membershipId: string;
    if (!existing) {
      const [row] = await tx
        .insert(memberships)
        .values({ tenantId, userId, createdBy: userId })
        .returning({ id: memberships.id });
      if (!row) throw new Error('Membership insert returned no row');
      membershipId = row.id;
    } else {
      membershipId = existing.id;
      // আগে বাদ দেওয়া মানুষ ফিরছে: unique (tenant_id, user_id) index-এর কারণে নতুন রো হয় না, পুরনোটাই
      // চালু — তার পুরনো audit আর কাজের ইতিহাস একই সদস্যপদে জোড়া থাকে
      if (existing.deletedAt !== null) {
        await tx
          .update(memberships)
          .set({ deletedAt: null, version: sql`${memberships.version} + 1`, updatedBy: userId })
          .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));
      }
    }

    const granted = await tx
      .select({ id: roles.id, name: roles.name })
      .from(invitationRoles)
      .innerJoin(
        roles,
        and(eq(roles.tenantId, invitationRoles.tenantId), eq(roles.id, invitationRoles.roleId)),
      )
      .where(
        and(eq(invitationRoles.tenantId, tenantId), eq(invitationRoles.invitationId, invitationId)),
      )
      .orderBy(asc(roles.name));
    if (granted.length > 0) {
      await tx
        .insert(membershipRoles)
        .values(
          granted.map((role) => ({ tenantId, membershipId, roleId: role.id, createdBy: userId })),
        )
        // ইতিমধ্যে সদস্য (অন্য পথে ঢুকেছে) আর একই রোল আছে — দুবার না
        .onConflictDoNothing();
    }

    await tx
      .update(invitations)
      .set({
        acceptedAt: new Date(),
        version: sql`${invitations.version} + 1`,
        updatedBy: userId,
      })
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, invitationId)));
    await audit(tx, {
      action: 'member.joined',
      entityType: 'member',
      entityId: membershipId,
      // public রুট — principal নেই, তাই কে করল সেটা বলে দেওয়া (লগইনের audit-এর মতো)
      actorUserId: userId,
      changes: created({ email: invitation.email, roles: names(granted) }),
    });
    // The inviter hears about it in the bell (worker, MemberJoinedHandler)
    await emit(tx, 'member.joined', { membershipId, inviterId: invitation.createdBy });
  }

  // token দিয়ে খোঁজা, টেন্যান্ট জানার আগে। invitations-এ FORCE RLS; migration 0010-এর invitation_by_token
  // policy শুধু সেই রো দেখায় যার hash এই transaction-এ বসানো — token না জানলে কিছুই দেখা যায় না
  private async findByToken(token: string): Promise<InvitationRow> {
    const hash = hashInvitationToken(token);
    const [row] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.invitation_token_hash', ${hash}, true)`);
      return tx.select().from(invitations).where(eq(invitations.tokenHash, hash));
    });
    if (!row || !isUsable(row)) throw invitationInvalid();
    return row;
  }

  private async lockOpen(tx: Transaction, id: string): Promise<InvitationRow> {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, getTenantId()),
          eq(invitations.id, id),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .for('update');
    if (!row) throw notFound('Invitation');
    return row;
  }

  private async roleIdsOf(tx: Transaction, invitationId: string): Promise<string[]> {
    const rows = await tx
      .select({ roleId: invitationRoles.roleId })
      .from(invitationRoles)
      .where(
        and(
          eq(invitationRoles.tenantId, getTenantId()),
          eq(invitationRoles.invitationId, invitationId),
        ),
      );
    return rows.map((row) => row.roleId);
  }

  // খোলা invitation-গুলো (বা শুধু ids), নতুন আগে, রোল আর কে ডেকেছে সহ
  private async readOpen(tx: Transaction, ids?: readonly string[]): Promise<Invitation[]> {
    const tenantId = getTenantId();
    const rows = await tx
      .select({ invitation: invitations, inviterName: users.fullName })
      .from(invitations)
      // left join: ডেকেছিলেন এমন কারো অ্যাকাউন্ট না থাকলেও invitation দেখা যায় (invitedBy: null)
      .leftJoin(users, eq(users.id, invitations.createdBy))
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          ids && inArray(invitations.id, [...ids]),
        ),
      )
      .orderBy(desc(invitations.createdAt));

    const invitationIds = rows.map((row) => row.invitation.id);
    const roleRows =
      invitationIds.length === 0
        ? []
        : await tx
            .select({ invitationId: invitationRoles.invitationId, id: roles.id, name: roles.name })
            .from(invitationRoles)
            .innerJoin(
              roles,
              and(
                eq(roles.tenantId, invitationRoles.tenantId),
                eq(roles.id, invitationRoles.roleId),
              ),
            )
            .where(
              and(
                eq(invitationRoles.tenantId, tenantId),
                inArray(invitationRoles.invitationId, invitationIds),
              ),
            )
            .orderBy(asc(roles.name));

    const rolesByInvitation = new Map<string, RoleRef[]>();
    for (const { invitationId, ...role } of roleRows) {
      rolesByInvitation.set(invitationId, [...(rolesByInvitation.get(invitationId) ?? []), role]);
    }

    return rows.map(({ invitation, inviterName }) => ({
      id: invitation.id,
      email: invitation.email,
      roles: rolesByInvitation.get(invitation.id) ?? [],
      invitedBy:
        invitation.createdBy !== null && inviterName !== null
          ? { id: invitation.createdBy, fullName: inviterName }
          : null,
      delivery: deliveryOf(invitation),
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
      version: invitation.version,
    }));
  }
}
