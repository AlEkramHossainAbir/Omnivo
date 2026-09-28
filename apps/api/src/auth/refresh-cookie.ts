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