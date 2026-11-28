import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  type Auth,
  AuthError,
  type Identity,
  type IssuedTokens,
  type Principal,
  type RefreshGrant,
} from '@omnivo/auth';
import {
  EMAIL_VERIFICATION_TTL_HOURS,
  type LoginInput,
  type MeResponse,
  type Preferences,
  type SignUpInput,
  type SignUpResult,
  type UpdatePreferencesInput,
} from '@omnivo/contracts';
import {
  type Db,
  OWNER_ROLE_NAME,
  branches,
  emailVerifications,
  membershipRoles,
  memberships,
  roles,
  sessions,
  tenantSettings,
  tenants,
  users,
  warehouses,
} from '@omnivo/db';

import { audit, created } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { accessRevoked, AppError } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
import {
  setTenantContext,
  type Transaction,
  type WithTenant,
} from '../common/tenant/with-tenant.js';
import type { WithUser } from '../common/tenant/with-user.js';
import { AUTH, DB, WITH_TENANT, WITH_USER } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { pickWorkspace, type WorkspaceOption } from './pick-workspace.js';
import { VerificationLimits } from './verification-limits.js';
import { hashVerificationToken } from './verification-token.js';

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

// Step 3b: the password was right, but there is no workspace to open
function notAMember(): AppError {
  return new AppError(403, 'not_a_member', "This account isn't a member of any workspace.");
}

// The password was right, but the address is not confirmed yet. The sign-in sent a new link
function emailNotVerified(): AppError {
  return new AppError(
    403,
    'email_not_verified',
    'Confirm the email address first. A new link was sent to it.',
  );
}

// One answer for an unknown, used and expired link: a stranger learns nothing from it
function verificationLinkInvalid(): AppError {
  return new AppError(400, 'verification_link_invalid', 'This link no longer works.');
}

function linkExpiresAt(): Date {
  return new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000);
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(WITH_USER) private readonly withUser: WithUser,
    private readonly permissionService: PermissionService,
    private readonly verificationLimits: VerificationLimits,
  ) {}

  // The workspace is made now, but no token is given out: the session Better Auth made waits in
  // email_verifications until the person opens the email's link (verifyEmail)
  async signUp(input: SignUpInput): Promise<SignUpResult> {
    // ইউজার তৈরির আগে slug চেক — নাহলে প্রায় প্রতিটা "taken" ক্ষেত্রে ইউজার বানিয়ে আবার মুছতে হতো
    if (await this.findTenantBySlug(input.workspaceSlug)) {
      throw workspaceTaken(input.workspaceSlug);
    }

    const identity = await this.createAccount({
      email: input.email,
      password: input.password,
      fullName: input.fullName,
    });

    let workspace: { tenantId: string };
    try {
      workspace = await this.provisionWorkspace(identity, input);
    } catch (error) {
      // Better Auth-এর ইউজার আর আমাদের workspace আলাদা transaction-এ — তাই হাতে rollback।
      // provision-এর transaction rollback হয়েছে, তাই এই ইউজারের কোনো membership নেই, মোছা যায়
      await this.auth.deleteUser(identity.userId);
      // pre-check-এর পরে কেউ একই slug নিয়ে ফেললে (race) unique index ধরবে
      if (isUniqueViolation(error, 'tenants_slug_idx')) throw workspaceTaken(input.workspaceSlug);
      throw error;
    }
    // Step 3b: a new owner's next sign-in opens the company they just made
    await this.rememberWorkspace(identity.userId, workspace.tenantId);

    // input.email went through emailSchema, so it is the address exactly as users.email has it
    return { status: 'verify_email', email: input.email };
  }

  // The email's link. Confirms the address, then finishes the sign-in that sign-up (or a refused
  // sign-in) started, in the workspace the person created
  async verifyEmail(token: string): Promise<IssuedTokens> {
    const hash = hashVerificationToken(token);
    // Which workspace first, so the confirmation, its audit row and the welcome email are one
    // transaction in that tenant. A row's tenant never changes once written, so this read cannot
    // go stale; the locked read below checks everything else again
    const [candidate] = await this.db
      .select({ tenantId: emailVerifications.tenantId })
      .from(emailVerifications)
      .where(eq(emailVerifications.tokenHash, hash));
    if (!candidate) throw verificationLinkInvalid();

    const now = new Date();
    const verified = await runWithTenant(candidate.tenantId, () =>
      this.withTenant(async (tx) => {
        // FOR UPDATE: the same link opened twice at once (two tabs, or a mail scanner that opens
        // links). The second waits, then sees token_hash NULL and gets "no longer works"
        const [row] = await tx
          .select({ userId: emailVerifications.userId, sessionId: emailVerifications.sessionId })
          .from(emailVerifications)
          .where(
            and(
              eq(emailVerifications.tokenHash, hash),
              isNull(emailVerifications.verifiedAt),
              gt(emailVerifications.expiresAt, now),
            ),
          )
          .for('update');
        if (!row) return null;

        // token_hash NULL: a link works once
        await tx
          .update(emailVerifications)
          .set({ tokenHash: null, verifiedAt: now })
          .where(eq(emailVerifications.userId, row.userId));
        // updated_at kept, like rememberWorkspace: it means "the profile changed"
        await tx
          .update(users)
          .set({ emailVerified: true, updatedAt: sql`${users.updatedAt}` })
          .where(eq(users.id, row.userId));
        await audit(tx, {
          action: 'auth.email_verified',
          entityType: 'user',
          entityId: row.userId,
          actorUserId: row.userId,
        });
        // The welcome email waits for the address to be real, so a new owner gets one email at a time
        await emit(tx, 'workspace.created', { userId: row.userId });
        return row;
      }),
    );
    if (!verified) throw verificationLinkInvalid();

    // The address is confirmed from here on, even when the session below is gone: then the
    // person signs in with the password, and the sign-in lets them in
    const [session] = verified.sessionId
      ? await this.db
          .select({ id: sessions.id, expiresAt: sessions.expiresAt })
          .from(sessions)
          .where(and(eq(sessions.id, verified.sessionId), gt(sessions.expiresAt, now)))
      : [];
    if (!session) throw sessionEnded();

    // The workspace they created, unless they were taken out of it since; then the sign-in's own rule
    const tenantId = (await this.findMembership(candidate.tenantId, verified.userId))
      ? candidate.tenantId
      : pickWorkspace(
          await this.listWorkspaces(verified.userId),
          undefined,
          await this.lastTenantOf(verified.userId),
        )?.tenantId;
    const membership = tenantId ? await this.findMembership(tenantId, verified.userId) : null;
    if (!tenantId || !membership) {
      await this.auth.revokeSession(session.id);
      throw notAMember();
    }

    await this.rememberWorkspace(verified.userId, tenantId);
    return this.reissue({
      sessionId: session.id,
      sessionExpiresAt: session.expiresAt,
      claims: { userId: verified.userId, tenantId, ...membership },
    });
  }

  // "Send the link again". Says nothing about the address: no account, an address confirmed
  // already and a limit reached all end quietly, and the controller answers 204 to all of them
  async resendVerification(email: string): Promise<void> {
    const [row] = await this.db
      .select({
        userId: users.id,
        emailVerified: users.emailVerified,
        tenantId: emailVerifications.tenantId,
        verifiedAt: emailVerifications.verifiedAt,
      })
      .from(users)
      .innerJoin(emailVerifications, eq(emailVerifications.userId, users.id))
      .where(eq(users.email, email));
    if (!row || row.emailVerified || row.verifiedAt !== null) return;
    if (!(await this.verificationLimits.take(row.userId))) return;

    await runWithTenant(row.tenantId, () =>
      this.withTenant(async (tx) => {
        await this.killLink(tx, row.userId);
        await emit(tx, 'account.verification_requested', { userId: row.userId });
      }),
    );
  }

  async login(input: LoginInput): Promise<IssuedTokens> {
    // Step 3b: the password first. Until the person has proved who they are, nothing about
    // workspaces is read, so a stranger cannot learn which addresses exist.
    const identity = await this.verifyPassword({
      email: input.email,
      password: input.password,
      keepSignedIn: input.keepSignedIn,
    });

    const workspace = pickWorkspace(
      await this.listWorkspaces(identity.userId),
      input.workspace,
      await this.lastTenantOf(identity.userId),
    );
    // The roles, read inside that workspace. null also when the membership was removed between
    // the two reads: rare, and it gets the same answer as no workspace at all.
    const membership = workspace
      ? await this.findMembership(workspace.tenantId, identity.userId)
      : null;
    if (!workspace || !membership) {
      // Better Auth already made a session for the right password; nothing may use it
      await this.auth.revokeSession(identity.sessionId);
      throw notAMember();
    }
    // After the workspace, so the rule is the same in every workspace the person is in, and a
    // switch never asks again: the address belongs to the person, not to a workspace
    if (!(await this.isEmailVerified(identity.userId))) {
      await this.sendLinkForSignIn(identity, workspace.tenantId);
      throw emailNotVerified();
    }

    await this.recordInTenant(workspace.tenantId, {
      action: 'auth.signed_in',
      entityType: 'user',
      entityId: identity.userId,
      actorUserId: identity.userId,
    });
    await this.rememberWorkspace(identity.userId, workspace.tenantId);

    return this.auth.issueTokens({
      sessionId: identity.sessionId,
      sessionExpiresAt: identity.sessionExpiresAt,
      claims: { userId: identity.userId, tenantId: workspace.tenantId, ...membership },
    });
  }

  // invitation গ্রহণ (invitations.service.ts) আর সাইনআপ — নতুন Better Auth ইউজার + session।
  // Better Auth-এর নিজের error এখানেই আমাদের code-এ বদলায়; facade-এর বাইরে কেউ AuthError দেখে না
  async createAccount(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<Identity> {
    try {
      return await this.auth.signUp(input);
    } catch (error) {
      if (error instanceof AuthError && error.code === 'EMAIL_TAKEN') {
        throw new AppError(409, 'email_taken', 'An account with this email already exists.', {
          fieldErrors: { email: ['email_taken'] },
        });
      }
      throw error;
    }
  }

  // লগইন আর বিদ্যমান অ্যাকাউন্টে invitation গ্রহণ — পাসওয়ার্ড যাচাই + নতুন session
  async verifyPassword(input: {
    email: string;
    password: string;
    keepSignedIn: boolean;
  }): Promise<Identity> {
    try {
      return await this.auth.signIn(input);
    } catch (error) {
      if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
        throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
      }
      throw error;
    }
  }

  // সদস্যপদ তৈরি হয়ে যাওয়ার পরে: সেই workspace-এর টোকেন। লগইনের শেষ ধাপের মতোই, শুধু membership
  // আগে থেকে জানা নেই বলে এখানে আবার পড়া (রোলের নাম টোকেনের claim-এ যায়)
  async startSessionIn(identity: Identity, tenantId: string): Promise<IssuedTokens> {
    const membership = await this.findMembership(tenantId, identity.userId);
    if (!membership) {
      await this.auth.revokeSession(identity.sessionId);
      throw accessRevoked();
    }
    // Step 3b: someone who accepts an invitation wants to work there; the next sign-in goes there
    await this.rememberWorkspace(identity.userId, tenantId);
    return this.auth.issueTokens({
      sessionId: identity.sessionId,
      sessionExpiresAt: identity.sessionExpiresAt,
      claims: { userId: identity.userId, tenantId, ...membership },
    });
  }

  async refresh(refreshToken: string | undefined): Promise<IssuedTokens> {
    const grant = await this.rotate(refreshToken);
    // টোকেনের রোল ১৫ মিনিট পর্যন্ত পুরনো থাকতে পারে; প্রতিটা refresh-এ DB থেকে নতুন করে
    const membership = await this.findMembership(grant.activeTenantId, grant.userId);
    if (!membership) {
      await this.auth.revokeSession(grant.sessionId);
      throw accessRevoked();
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

    // যে workspace-এ ঢুকল তার audit-এ — সেই কোম্পানির মালিক দেখবে কে কখন এসেছিল
    await this.recordInTenant(tenantId, {
      action: 'auth.switched_in',
      entityType: 'user',
      entityId: principal.userId,
      actorUserId: principal.userId,
    });
    // Step 3b: a switch is the clearest sign of where the person works now, on every device
    await this.rememberWorkspace(principal.userId, tenantId);

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
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        language: users.language,
        theme: users.theme,
      })
      .from(users)
      .where(eq(users.id, principal.userId));
    const [tenant] = await this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        setupStatus: tenants.setupStatus,
      })
      .from(tenants)
      .where(eq(tenants.id, principal.tenantId));
    if (!user || !tenant) throw sessionEnded();

    // tenant switcher-এর তালিকা: সব টেন্যান্ট জুড়ে নিজের membership
    const workspaces = await this.listWorkspaces(principal.userId);

    // রোল আর permission টোকেন থেকে না, এখনকার অবস্থা থেকে: টোকেনের roles ১৫ মিনিট পুরনো হতে পারে
    // (কেউ রোল বদলালে বা রোলের নাম বদলালে), UI-র মেনু তখন ভুল জিনিস দেখাত
    const access = await this.permissionService.forPrincipal(principal);
    if (!access) throw accessRevoked();

    return {
      user: { id: user.id, email: user.email, fullName: user.fullName },
      tenant,
      roles: access.roles,
      permissions: access.permissions,
      memberships: workspaces,
      preferences: { language: user.language, theme: user.theme },
    };
  }

  // users-এ RLS নেই (global টেবিল) — তাই শুধু টোকেনের userId-র রো, body থেকে কোনো id নেওয়া হয় না
  async updatePreferences(
    principal: Principal,
    input: UpdatePreferencesInput,
  ): Promise<Preferences> {
    const [row] = await this.db
      .update(users)
      .set({
        // exactOptionalPropertyTypes: না পাঠানো ফিল্ড undefined-ও না, একেবারে নেই — তাই drizzle
        // সেই কলাম ছোঁয় না। ভাষা বদলালে থিম অক্ষত থাকে
        ...(input.language !== undefined && { language: input.language }),
        ...(input.theme !== undefined && { theme: input.theme }),
        updatedBy: principal.userId,
      })
      .where(eq(users.id, principal.userId))
      .returning({ language: users.language, theme: users.theme });
    if (!row) throw sessionEnded();
    return row;
  }

  // public রুট (লগইন) বা অন্য টেন্যান্টে (switch) — তখনো ALS-এ ঠিক টেন্যান্ট বসিয়ে audit
  private recordInTenant(tenantId: string, event: Parameters<typeof audit>[1]): Promise<void> {
    return runWithTenant(tenantId, () => this.withTenant((tx) => audit(tx, event)));
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

  // The person's workspaces across every tenant, sorted by name: the workspace switcher's list
  // (me) and the sign-in's choices (login). withUser, not withTenant: there is no tenant yet,
  // and the own_memberships policy shows a person their own memberships only.
  private listWorkspaces(userId: string): Promise<WorkspaceOption[]> {
    return this.withUser(userId, (tx) =>
      tx
        .select({ tenantId: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(
          and(
            eq(memberships.userId, userId),
            isNull(memberships.deletedAt),
            isNull(tenants.deletedAt),
          ),
        )
        .orderBy(asc(tenants.name)),
    );
  }

  private async isEmailVerified(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId));
    return row?.emailVerified === true;
  }

  // A sign-in with the right password, but the address is not confirmed. This sign-in's session
  // takes the old one's place in the row, so the link (the new one, or the last one when the limit
  // says wait) finishes THIS sign-in; the old session never had a token, so ending it signs no one
  // out. No row at all = an account made by the old code while this version was being deployed:
  // it gets one now, for the workspace this sign-in picked.
  private async sendLinkForSignIn(identity: Identity, pickedTenantId: string): Promise<void> {
    const [existing] = await this.db
      .select({ tenantId: emailVerifications.tenantId, sessionId: emailVerifications.sessionId })
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, identity.userId));
    const tenantId = existing?.tenantId ?? pickedTenantId;
    const send = await this.verificationLimits.take(identity.userId);

    await runWithTenant(tenantId, () =>
      this.withTenant(async (tx) => {
        await tx
          .insert(emailVerifications)
          .values({
            userId: identity.userId,
            tenantId,
            sessionId: identity.sessionId,
            expiresAt: linkExpiresAt(),
          })
          .onConflictDoUpdate({
            target: emailVerifications.userId,
            set: { sessionId: identity.sessionId },
          });
        if (send) {
          await this.killLink(tx, identity.userId);
          await emit(tx, 'account.verification_requested', { userId: identity.userId });
        }
      }),
    );
    if (existing?.sessionId && existing.sessionId !== identity.sessionId) {
      await this.auth.revokeSession(existing.sessionId);
    }
  }

  // Before a new link: the old one stops at once (no hash to match), and sent_at NULL tells the
  // worker that this row waits for an email (verification-email.handler.ts)
  private async killLink(tx: Transaction, userId: string): Promise<void> {
    await tx
      .update(emailVerifications)
      .set({ tokenHash: null, sentAt: null })
      .where(eq(emailVerifications.userId, userId));
  }

  // users has no RLS (a global table), so the plain connection reads it
  private async lastTenantOf(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ lastTenantId: users.lastTenantId })
      .from(users)
      .where(eq(users.id, userId));
    return row?.lastTenantId ?? null;
  }

  // Step 3b: where the next sign-in goes when the browser gives no hint. updated_at is kept as
  // it was: it means "the profile changed", and a sign-in changes nothing the person typed.
  private async rememberWorkspace(userId: string, tenantId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastTenantId: tenantId, updatedAt: sql`${users.updatedAt}` })
      .where(eq(users.id, userId));
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

  // একটা transaction: tenant → (context বসিয়ে) membership → owner রোল → রোল বরাদ্দ
  private async provisionWorkspace(
    identity: Identity,
    input: SignUpInput,
  ): Promise<{ tenantId: string }> {
    const { userId } = identity;
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
      // kind: 'owner' — অধিকার কোডে (PermissionService), তাই role_permissions-এ কিছু লেখা লাগে না,
      // আর পরে নতুন permission এলে এই workspace আপনা-আপনি পায়
      const [owner] = await tx
        .insert(roles)
        .values({ tenantId: tenant.id, name: OWNER_ROLE_NAME, kind: 'owner', createdBy: userId })
        .returning({ id: roles.id });
      if (!membership || !owner) throw new Error('Membership or role insert returned no row');

      await tx.insert(membershipRoles).values({
        tenantId: tenant.id,
        membershipId: membership.id,
        roleId: owner.id,
        createdBy: userId,
      });

      // settings রো (বাকি সব DB-র ডিফল্ট: BDT, জুলাই, Asia/Dhaka) আর একটা ব্রাঞ্চ — প্রতিটা
      // workspace-এ অন্তত একটা চালু ব্রাঞ্চ থাকে, archive-এর নিয়ম সেটা ধরে রাখে (branches.service.ts)
      await tx.insert(tenantSettings).values({ tenantId: tenant.id, updatedBy: userId });
      const [branch] = await tx
        .insert(branches)
        .values({ tenantId: tenant.id, code: 'HO', name: 'Head office', createdBy: userId })
        .returning({ id: branches.id });
      if (!branch) throw new Error('Branch insert returned no row');
      // And a first warehouse in it (step 13): stock always lives in a warehouse, and a new
      // company's opening stock needs somewhere to go. Migration 0022 gave older workspaces theirs.
      await tx.insert(warehouses).values({
        tenantId: tenant.id,
        branchId: branch.id,
        code: 'MAIN',
        name: 'Main store',
        createdBy: userId,
      });

      await audit(tx, {
        action: 'workspace.created',
        entityType: 'workspace',
        entityId: tenant.id,
        actorUserId: userId,
        changes: created({ name: input.companyName, slug: input.workspaceSlug }),
      });
      // The link that confirms the address. The row holds the session sign-up made, and the
      // worker emails the link after the commit: sign-up never waits for a mail server, and
      // cannot fail because of one. The welcome email follows once the link is opened.
      await tx.insert(emailVerifications).values({
        userId,
        tenantId: tenant.id,
        sessionId: identity.sessionId,
        expiresAt: linkExpiresAt(),
      });
      await emit(tx, 'account.verification_requested', { userId });

      return { tenantId: tenant.id };
    });
  }
}
