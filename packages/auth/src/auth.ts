import { eq } from 'drizzle-orm';
import { isAPIError } from 'better-auth/api';
import { sessions, users, type Db } from '@omnivo/db';

import { createAccessTokens, type AccessClaims, type AccessTokenConfig } from './access-token.js';
import { AuthError } from './errors.js';
import { createIdentityProvider } from './identity.js';
import {
  consumeRefreshToken,
  createRefreshToken,
  revokeSessionByRefreshToken,
  type RefreshGrant,
} from './refresh-token.js';

export interface AuthOptions {
  db: Db;
  betterAuthSecret: string;
  baseURL: string;
  sessionTtlSeconds: number;
  accessToken: AccessTokenConfig;
}

// Better Auth-এর session (= একটা ডিভাইসের লগইন); refresh token এর সাথে বাঁধা থাকে
export interface Identity {
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

// Better Auth-এর error কোড → আমাদের AuthError; অচেনা হলে undefined (caller আসল error ছুড়বে)
function toAuthError(error: unknown): AuthError | undefined {
  if (!isAPIError(error)) return undefined;
  const code: unknown = error.body?.code;
  if (code === 'INVALID_EMAIL_OR_PASSWORD') return new AuthError('INVALID_CREDENTIALS');
  if (code === 'USER_ALREADY_EXISTS' || code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
    return new AuthError('EMAIL_TAKEN');
  }
  return undefined;
}

export function createAuth(options: AuthOptions) {
  const { db } = options;
  const identity = createIdentityProvider({
    db,
    secret: options.betterAuthSecret,
    baseURL: options.baseURL,
    sessionTtlSeconds: options.sessionTtlSeconds,
  });
  const accessTokens = createAccessTokens(options.accessToken);

  // Better Auth session token ফেরত দেয়, id না — refresh_tokens.session_id-এর জন্য id লাগবে
  async function identityFromSessionToken(userId: string, token: string): Promise<Identity> {
    const [session] = await db
      .select({ id: sessions.id, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.token, token));
    if (!session) throw new Error('Better Auth created a session that cannot be found');
    return { userId, sessionId: session.id, sessionExpiresAt: session.expiresAt };
  }

  return {
    async signUp(input: { email: string; password: string; fullName: string }): Promise<Identity> {
      try {
        const result = await identity.api.signUpEmail({
          body: { email: input.email, password: input.password, name: input.fullName },
        });
        // autoSignIn: true, তাই token সবসময় থাকে; null মানে config বদলে গেছে
        if (!result.token) throw new Error('Better Auth did not create a session on sign-up');
        return await identityFromSessionToken(result.user.id, result.token);
      } catch (error) {
        throw toAuthError(error) ?? error;
      }
    },

    async signIn(input: {
      email: string;
      password: string;
      keepSignedIn: boolean;
    }): Promise<Identity> {
      try {
        const result = await identity.api.signInEmail({
          // rememberMe: false হলে Better Auth session ১ দিনে শেষ হয়
          body: { email: input.email, password: input.password, rememberMe: input.keepSignedIn },
        });
        return await identityFromSessionToken(result.user.id, result.token);
      } catch (error) {
        throw toAuthError(error) ?? error;
      }
    },

    // sign-up-এর পরের ধাপ ব্যর্থ হলে "compensating action" — cascade-এ account/session-ও মোছে
    async deleteUser(userId: string): Promise<void> {
      await db.delete(users).where(eq(users.id, userId));
    },

    async revokeSession(sessionId: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    },

    async issueTokens(input: {
      sessionId: string;
      sessionExpiresAt: Date;
      claims: AccessClaims;
    }): Promise<IssuedTokens> {
      const refreshToken = await createRefreshToken(db, {
        sessionId: input.sessionId,
        activeTenantId: input.claims.tenantId,
        expiresAt: input.sessionExpiresAt,
      });
      const access = await accessTokens.sign(input.claims);
      return {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken,
        refreshTokenExpiresAt: input.sessionExpiresAt,
      };
    },

    rotateRefreshToken(refreshToken: string): Promise<RefreshGrant> {
      return consumeRefreshToken(db, refreshToken);
    },

    revokeRefreshToken(refreshToken: string): Promise<void> {
      return revokeSessionByRefreshToken(db, refreshToken);
    },

    getPrincipal: accessTokens.verify,
  };
}

export type Auth = ReturnType<typeof createAuth>;
