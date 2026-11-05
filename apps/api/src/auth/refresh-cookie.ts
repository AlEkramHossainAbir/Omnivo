import type { IssuedTokens } from '@omnivo/auth';
import type { AuthSession } from '@omnivo/contracts';
import type { FastifyReply } from 'fastify';

export const REFRESH_COOKIE = 'omnivo_rt';

// cookie শুধু /auth/*-এ যায় (refresh, logout, switch-tenant) — বাকি API request-এ না
const COOKIE_PATH = '/auth';

export function setRefreshCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  secure: boolean,
): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
  });
}

// session শুরুর উত্তর — সাইনআপ, লগইন, refresh, switch আর invitation গ্রহণ, সবগুলোর একই আকার।
// refresh token শুধু httpOnly cookie-তে; JSON-এ শুধু access token — JS কখনো refresh token দেখে না
export function sessionResponse(
  reply: FastifyReply,
  tokens: IssuedTokens,
  secure: boolean,
): AuthSession {
  setRefreshCookie(reply, tokens.refreshToken, tokens.refreshTokenExpiresAt, secure);
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
  };
}
