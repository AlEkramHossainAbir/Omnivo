import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { authSessionSchema, type LoginInput, type SignUpInput } from '@omnivo/contracts';
import { expect } from 'vitest';

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

export async function signUp(app: NestFastifyApplication, input: SignUpInput): Promise<SignedIn> {
  const response = await app.inject({ method: 'POST', url: '/auth/sign-up', payload: input });
  expect(response.statusCode).toBe(201);
  return sessionOf(response);
}

export function bearer(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}

export async function logIn(app: NestFastifyApplication, input: LoginInput): Promise<SignedIn> {
  const response = await app.inject({ method: 'POST', url: '/auth/login', payload: input });
  expect(response.statusCode).toBe(200);
  return sessionOf(response);
}
