import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { refreshTokens, sessions, type Db } from '@omnivo/db';

import { AuthError } from './errors.js';

export interface RefreshGrant {
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
  activeTenantId: string;
}

// টোকেন নিজে 256-bit random, তাই brute-force অসম্ভব — bcrypt/scrypt লাগে না, SHA-256 যথেষ্ট।
// DB-তে শুধু hash থাকে: DB dump লিক হলেও কেউ সেখান থেকে cookie বানাতে পারবে না
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// drizzle Postgres error-কে DrizzleQueryError-এ মুড়ে দেয়; আসল কোড থাকে .cause-এ
function isSessionGone(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      'code' in current &&
      current.code === '23503' &&
      'constraint_name' in current &&
      current.constraint_name === 'refresh_tokens_session_id_sessions_id_fk'
    ) {
      return true;
    }
  }
  return false;
}

export async function createRefreshToken(
  db: Db,
  input: { sessionId: string; activeTenantId: string; expiresAt: Date },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  try {
    await db.insert(refreshTokens).values({
      sessionId: input.sessionId,
      tokenHash: hashRefreshToken(token),
      activeTenantId: input.activeTenantId,
      expiresAt: input.expiresAt,
    });
  } catch (error) {
    // rotate আর এই insert-এর মাঝে অন্য request (reuse detection, logout) session মুছে দিলে
    // FK ভাঙে — এটা DB-র গোলমাল না, session শেষ; caller 401 দেবে, 500 না
    if (isSessionGone(error)) throw new AuthError('SESSION_ENDED');
    throw error;
  }
  return token;
}

export async function consumeRefreshToken(db: Db, token: string): Promise<RefreshGrant> {
  const tokenHash = hashRefreshToken(token);

  // একটাই atomic UPDATE: দুটো request একই টোকেন একসাথে পাঠালে row lock-এর কারণে
  // শুধু একটা `used_at IS NULL` দেখবে — অন্যটা 0 রো পাবে আর reuse হিসেবে ধরা পড়বে
  const [consumed] = await db
    .update(refreshTokens)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.usedAt),
        gt(refreshTokens.expiresAt, sql`now()`),
      ),
    )
    .returning({
      sessionId: refreshTokens.sessionId,
      activeTenantId: refreshTokens.activeTenantId,
    });

  if (consumed) {
    const [session] = await db
      .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(and(eq(sessions.id, consumed.sessionId), gt(sessions.expiresAt, sql`now()`)));
    if (!session) throw new AuthError('INVALID_REFRESH_TOKEN');
    return {
      userId: session.userId,
      sessionId: consumed.sessionId,
      sessionExpiresAt: session.expiresAt,
      activeTenantId: consumed.activeTenantId,
    };
  }

  // UPDATE কিছু পায়নি: টোকেনটা কি আগে ব্যবহার হয়েছে, নাকি একেবারে অচেনা/মেয়াদোত্তীর্ণ?
  const [existing] = await db
    .select({ sessionId: refreshTokens.sessionId, usedAt: refreshTokens.usedAt })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash));

  if (existing?.usedAt) {
    // পুরনো টোকেন আবার এসেছে = কেউ কপি করে রেখেছিল। কে আসল আর কে চোর বোঝার উপায় নেই,
    // তাই পুরো session (আর cascade-এ তার সব refresh token) মুছে দুজনকেই লগআউট
    await db.delete(sessions).where(eq(sessions.id, existing.sessionId));
    throw new AuthError('REFRESH_TOKEN_REUSED');
  }
  throw new AuthError('INVALID_REFRESH_TOKEN');
}

export async function revokeSessionByRefreshToken(db: Db, token: string): Promise<void> {
  const [row] = await db
    .select({ sessionId: refreshTokens.sessionId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashRefreshToken(token)));
  if (row) {
    await db.delete(sessions).where(eq(sessions.id, row.sessionId));
  }
}
