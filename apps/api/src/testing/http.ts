import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  authSessionSchema,
  EMAIL_VERIFICATION_TTL_HOURS,
  type LoginInput,
  signUpResultSchema,
  type SignUpInput,
} from '@omnivo/contracts';
import { type Db, emailVerifications, users } from '@omnivo/db';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';

import { newVerificationToken } from '../auth/verification-token.js';
import { DB } from '../infra/tokens.js';

type InjectResponse = Awaited<ReturnType<NestFastifyApplication['inject']>>;

// light-my-request-এর cookies: [{ name, value, ... }] — নাম দিয়ে একটা খোঁজা
export function refreshCookieOf(response: InjectResponse): string {
  const cookie = response.cookies.find((c) => c.name === 'omnivo_rt');
  if (!cookie) throw new Error(`no omnivo_rt cookie in ${String(response.statusCode)} response`);
  return cookie.value;
}

export interface SignedIn {
  accessToken: string;
  refreshToken: string;
}

export function sessionOf(response: InjectResponse): SignedIn {
  const body = authSessionSchema.parse(response.json());
  return { accessToken: body.accessToken, refreshToken: refreshCookieOf(response) };
}

// A working link for this address, as the worker would make it, without the worker or a mail
// server: most tests run neither. sent_at is set too, so a worker that does run skips the row
// (verification-email.handler.ts) and cannot replace this link with its own. If the worker got
// there first, this overwrites its link, which is fine: that email's link simply stops working.
export async function verificationTokenFor(
  app: NestFastifyApplication,
  email: string,
): Promise<string> {
  const db = app.get<symbol, Db>(DB);
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!user) throw new Error(`no user ${email}`);
  const { token, hash } = newVerificationToken();
  await db
    .update(emailVerifications)
    .set({
      tokenHash: hash,
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000),
    })
    .where(eq(emailVerifications.userId, user.id));
  return token;
}

export function verifyEmail(app: NestFastifyApplication, token: string) {
  return app.inject({ method: 'POST', url: '/auth/verify-email', payload: { token } });
}

// Sign-up, then the email's link: the owner ends up signed in, as before the email check, and
// through the same route a person's click takes
export async function signUp(app: NestFastifyApplication, input: SignUpInput): Promise<SignedIn> {
  const response = await app.inject({ method: 'POST', url: '/auth/sign-up', payload: input });
  expect(response.statusCode).toBe(201);
  const { email } = signUpResultSchema.parse(response.json());
  const verified = await verifyEmail(app, await verificationTokenFor(app, email));
  expect(verified.statusCode).toBe(200);
  return sessionOf(verified);
}

export function bearer(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}

export async function logIn(app: NestFastifyApplication, input: LoginInput): Promise<SignedIn> {
  const response = await app.inject({ method: 'POST', url: '/auth/login', payload: input });
  expect(response.statusCode).toBe(200);
  return sessionOf(response);
}
