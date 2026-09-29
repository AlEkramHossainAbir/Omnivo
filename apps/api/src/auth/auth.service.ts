import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  type Auth,
  AuthError,
  type Identity,
  type IssuedTokens,
  type Principal,
  type RefreshGrant,
} from '@omnivo/auth';
import type { LoginInput, MeResponse, SignUpInput } from '@omnivo/contracts';
import {
  type Db,
  OWNER_ROLE_NAME,
  membershipRoles,
  memberships,
  permissions,
  rolePermissions,
  roles,
  tenants,
  users,
} from '@omnivo/db';

import { AppError } from '../common/http/app-error.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
import { setTenantContext, type WithTenant } from '../common/tenant/with-tenant.js';
import type { WithUser } from '../common/tenant/with-user.js';
import { AUTH, DB, WITH_TENANT, WITH_USER } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';

interface MembershipGrant {
  membershipId: string;
  roles: string[];
}

function workspaceTaken(slug: string): AppError {
  return new AppError(409, 'slug_taken', `${slug}.omnivo.app is taken.`, {
    fieldErrors: { workspaceSlug: ['slug_taken'] },
  });
}

function sessionEnded(): AppError {
  return new AppError(401, 'session_ended', 'The session has ended. Sign in again.');
}

// drizzle Postgres error-কে DrizzleQueryError-এ মুড়ে দেয়; আসল কোড থাকে .cause-এ
function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint_name' in current &&
      current.constraint_name === constraint
    ) {
      return true;
    }
  }
  return false;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(WITH_USER) private readonly withUser: WithUser,
    private readonly permissionService: PermissionService,
  ) {}

  async signUp(input: SignUpInput): Promise<IssuedTokens> {
    // ইউজার তৈরির আগে slug চেক — নাহলে প্রায় প্রতিটা "taken" ক্ষেত্রে ইউজার বানিয়ে আবার মুছতে হতো
    if (await this.findTenantBySlug(input.workspaceSlug)) {
      throw workspaceTaken(input.workspaceSlug);
    }

    let identity: Identity;
    try {
      identity = await this.auth.signUp({
        email: input.email,
        password: input.password,
        fullName: input.fullName,
      });
    } catch (error) {
      if (error instanceof AuthError && error.code === 'EMAIL_TAKEN') {
        throw new AppError(409, 'email_taken', 'An account with this email already exists.', {
          fieldErrors: { email: ['email_taken'] },
        });
      }
      throw error;
    }

    let workspace: { tenantId: string } & MembershipGrant;
    try {
      workspace = await this.provisionWorkspace(identity.userId, input);
    } catch (error) {
      // Better Auth-এর ইউজার আর আমাদের workspace আলাদা transaction-এ — তাই হাতে rollback।
      // provision-এর transaction rollback হয়েছে, তাই এই ইউজারের কোনো membership নেই, মোছা যায়
      await this.auth.deleteUser(identity.userId);
      // pre-check-এর পরে কেউ একই slug নিয়ে ফেললে (race) unique index ধরবে
      if (isUniqueViolation(error, 'tenants_slug_idx')) throw workspaceTaken(input.workspaceSlug);
      throw error;
    }

    return this.auth.issueTokens({
      sessionId: identity.sessionId,
      sessionExpiresAt: identity.sessionExpiresAt,
      claims: { userId: identity.userId, ...workspace },
    });
  }

  async login(input: LoginInput): Promise<IssuedTokens> {
    const tenant = await this.findTenantBySlug(input.workspace);
    if (!tenant) {
      throw new AppError(
        404,
        'workspace_not_found',
        `No workspace at ${input.workspace}.omnivo.app.`,
        {
          fieldErrors: { workspace: ['workspace_not_found'] },
        },
      );
    }

    let identity: Identity;
    try {
      identity = await this.auth.signIn({
        email: input.email,
        password: input.password,
        keepSignedIn: input.keepSignedIn,
      });
    } catch (error) {
      if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
        throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
      }
      throw error;
    }

    const membership = await this.findMembership(tenant.id, identity.userId);
    if (!membership) {
      // পাসওয়ার্ড ঠিক, কিন্তু এই workspace-এ নেই — Better Auth যে session বানিয়েছে সেটা ফেলে দেওয়া
      await this.auth.revokeSession(identity.sessionId);
      throw new AppError(
        403,
        'not_a_member',
        `This account isn't a member of ${tenant.slug}.omnivo.app.`,
      );
    }

    return this.auth.issueTokens({
      sessionId: identity.sessionId,
      sessionExpiresAt: identity.sessionExpiresAt,
      claims: { userId: identity.userId, tenantId: tenant.id, ...membership },
    });
  }

  async refresh(refreshToken: string | undefined): Promise<IssuedTokens> {
    const grant = await this.rotate(refreshToken);
    // টোকেনের রোল ১৫ মিনিট পর্যন্ত পুরনো থাকতে পারে; প্রতিটা refresh-এ DB থেকে নতুন করে
    const membership = await this.findMembership(grant.activeTenantId, grant.userId);
    if (!membership) {
      await this.auth.revokeSession(grant.sessionId);
      throw new AppError(
        401,
        'access_revoked',
        'The user is no longer a member of this workspace.',
      );
    }
    return this.reissue({
      sessionId: grant.sessionId,
      sessionExpiresAt: grant.sessionExpiresAt,
      claims: { userId: grant.userId, tenantId: grant.activeTenantId, ...membership },
    });
  }

  async switchTenant(
    principal: Principal,
    refreshToken: string | undefined,
    tenantId: string,
  ): Promise<IssuedTokens> {
    // refresh token খরচ করার আগে membership যাচাই — নাহলে ভুল tenantId দিলেই লগআউট হয়ে যেত
    const membership = await this.findMembership(tenantId, principal.userId);
    if (!membership) {
      throw new AppError(403, 'switch_denied', 'The user is not a member of that workspace.');
    }

    const grant = await this.rotate(refreshToken);
    if (grant.userId !== principal.userId) {
      // access token এক ইউজারের, cookie আরেকজনের — এমন অবস্থা স্বাভাবিকভাবে হয় না
      await this.auth.revokeSession(grant.sessionId);
      throw sessionEnded();
    }

    return this.reissue({
      sessionId: grant.sessionId,
      sessionExpiresAt: grant.sessionExpiresAt,
      claims: { userId: principal.userId, tenantId, ...membership },
    });
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await this.auth.revokeRefreshToken(refreshToken);
  }

  async me(principal: Principal): Promise<MeResponse> {
    const [user] = await this.db
      .select({ id: users.id, email: users.email, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, principal.userId));
    const [tenant] = await this.db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, principal.tenantId));
    if (!user || !tenant) throw sessionEnded();

    // tenant switcher-এর তালিকা: সব টেন্যান্ট জুড়ে নিজের membership — তাই withTenant না, withUser
    const workspaces = await this.withUser(principal.userId, (tx) =>
      tx
        .select({ tenantId: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(
          and(
            eq(memberships.userId, principal.userId),
            isNull(memberships.deletedAt),
            isNull(tenants.deletedAt),
          ),
        )
        .orderBy(asc(tenants.name)),
    );

    const granted = await this.permissionService.forPrincipal(principal);

    return {
      user,
      tenant,
      roles: [...principal.roles],
      permissions: [...granted].sort(),
      memberships: workspaces,
    };
  }

  private async rotate(refreshToken: string | undefined): Promise<RefreshGrant> {
    if (!refreshToken) throw sessionEnded();
    try {
      return await this.auth.rotateRefreshToken(refreshToken);
    } catch (error) {
      if (error instanceof AuthError) {
        throw sessionEnded();
      }
      throw error;
    }
  }

  // rotate-এর পরে টোকেন বসানোর আগেই session মুছে যেতে পারে (একই টোকেনে সমান্তরাল refresh-এ
  // অন্যটা reuse ধরে session মোছে) — তখন AuthError('SESSION_ENDED'), সেটাও 401
  private async reissue(input: Parameters<Auth['issueTokens']>[0]): Promise<IssuedTokens> {
    try {
      return await this.auth.issueTokens(input);
    } catch (error) {
      if (error instanceof AuthError) {
        throw sessionEnded();
      }
      throw error;
    }
  }

  private async findTenantBySlug(slug: string) {
    const [tenant] = await this.db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(and(eq(tenants.slug, slug), isNull(tenants.deletedAt)));
    return tenant;
  }

  private async findMembership(tenantId: string, userId: string): Promise<MembershipGrant | null> {
    return runWithTenant(tenantId, () =>
      this.withTenant(async (tx) => {
        const [membership] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, tenantId),
              eq(memberships.userId, userId),
              isNull(memberships.deletedAt),
            ),
          );
        if (!membership) return null;

        const roleRows = await tx
          .select({ name: roles.name })
          .from(membershipRoles)
          .innerJoin(
            roles,
            and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
          )
          .where(
            and(
              eq(membershipRoles.membershipId, membership.id),
              isNull(membershipRoles.deletedAt),
              isNull(roles.deletedAt),
            ),
          )
          .orderBy(asc(roles.name));

        return { membershipId: membership.id, roles: roleRows.map((row) => row.name) };
      }),
    );
  }

  // একটা transaction: tenant → (context বসিয়ে) membership → Owner রোল → সব permission → রোল বরাদ্দ
  private async provisionWorkspace(
    userId: string,
    input: SignUpInput,
  ): Promise<{ tenantId: string } & MembershipGrant> {
    return this.db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({ name: input.companyName, slug: input.workspaceSlug })
        .returning({ id: tenants.id });
      if (!tenant) throw new Error('Tenant insert returned no row');

      // tenants-এ RLS নেই, কিন্তু বাকি সব টেবিলে FORCE RLS — এখান থেকে context লাগবে
      await setTenantContext(tx, tenant.id);

      const [membership] = await tx
        .insert(memberships)
        .values({ tenantId: tenant.id, userId, createdBy: userId })
        .returning({ id: memberships.id });
      const [owner] = await tx
        .insert(roles)
        .values({ tenantId: tenant.id, name: OWNER_ROLE_NAME, createdBy: userId })
        .returning({ id: roles.id });
      if (!membership || !owner) throw new Error('Membership or role insert returned no row');

      const allPermissions = await tx.select({ id: permissions.id }).from(permissions);
      if (allPermissions.length === 0) {
        throw new Error('The permissions table is empty — run `pnpm db:migrate`');
      }
      await tx.insert(rolePermissions).values(
        allPermissions.map((permission) => ({
          tenantId: tenant.id,
          roleId: owner.id,
          permissionId: permission.id,
          createdBy: userId,
        })),
      );
      await tx.insert(membershipRoles).values({
        tenantId: tenant.id,
        membershipId: membership.id,
        roleId: owner.id,
        createdBy: userId,
      });

      return { tenantId: tenant.id, membershipId: membership.id, roles: [OWNER_ROLE_NAME] };
    });
  }
}
