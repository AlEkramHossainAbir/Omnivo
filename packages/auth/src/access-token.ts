import { randomUUID } from 'node:crypto';
import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

export interface AccessTokenConfig {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

// টোকেনে যা ঢোকে — ADR 0002-এর কাস্টম claim
export interface AccessClaims {
  userId: string;
  tenantId: string;
  membershipId: string;
  roles: readonly string[];
  // Step 18c: the sign-in (Better Auth's session) this token belongs to. A device remembers the
  // session it used last, so revoking the device can end that sign-in.
  sessionId: string;
}

// যাচাই করা টোকেন থেকে যা বেরোয়
export interface Principal extends AccessClaims {
  tokenId: string;
  expiresAt: Date;
}

// jose শুধু স্ট্যান্ডার্ড claim (exp, iss, aud) যাচাই করে; আমাদের কাস্টম claim-এর আকার এখানে
const payloadSchema = z.object({
  sub: z.uuid(),
  jti: z.string().min(1),
  exp: z.number(),
  tenant_id: z.uuid(),
  membership_id: z.uuid(),
  roles: z.array(z.string()),
  // Step 18c. Required: a token from before this claim (15 minutes at most) is refused like an
  // expired one, and the app refreshes it once. An optional claim would make every caller handle
  // a session it does not know.
  sid: z.uuid(),
});

export function createAccessTokens(config: AccessTokenConfig) {
  const key = new TextEncoder().encode(config.secret);
  // HS256-এর key অন্তত 256 bit হওয়া উচিত (RFC 7518 §3.2); jose নিজে এটা চেক করে না
  if (key.byteLength < 32) {
    throw new Error(
      'JWT secret must be at least 32 bytes — generate one with `openssl rand -base64 32`',
    );
  }

  async function sign(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + config.ttlSeconds;
    const token = await new SignJWT({
      tenant_id: claims.tenantId,
      membership_id: claims.membershipId,
      roles: [...claims.roles],
      // "sid" is the usual JWT name for a session id (OpenID Connect)
      sid: claims.sessionId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(randomUUID())
      .sign(key);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  // ভুল/মেয়াদোত্তীর্ণ/জাল টোকেন → null (caller 401 দেবে); অন্য যেকোনো error → throw (সেটা bug)
  async function verify(token: string): Promise<Principal | null> {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['HS256'],
      });
      const claims = payloadSchema.safeParse(payload);
      if (!claims.success) return null;
      return {
        userId: claims.data.sub,
        tenantId: claims.data.tenant_id,
        membershipId: claims.data.membership_id,
        roles: claims.data.roles,
        sessionId: claims.data.sid,
        tokenId: claims.data.jti,
        expiresAt: new Date(claims.data.exp * 1000),
      };
    } catch (error) {
      if (error instanceof errors.JOSEError) return null;
      throw error;
    }
  }

  return { sign, verify };
}

export type AccessTokens = ReturnType<typeof createAccessTokens>;
