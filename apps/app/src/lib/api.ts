import {
  type ApiError,
  apiErrorSchema,
  type AuthSession,
  authSessionSchema,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { sessionStore } from './session-store';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
  }
}

async function toError(response: Response): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(body);
  return new ApiRequestError(
    response.status,
    parsed.success
      ? parsed.data
      : { statusCode: response.status, message: 'Something went wrong. Try again in a moment.' },
  );
}

// একই সময়ে যত request-ই 401 পাক, refresh একবারই যাবে — rotation-এ দ্বিতীয় refresh
// পুরনো cookie পাঠাত আর সার্ভার সেটাকে চুরি ভেবে পুরো session মুছে দিত
let refreshInFlight: Promise<AuthSession | null> | null = null;

export function refreshSession(): Promise<AuthSession | null> {
  refreshInFlight ??= navigator.locks
    // Web Locks: একই ব্রাউজারের একাধিক ট্যাবও একটার পর একটা refresh করবে, একসাথে না
    .request('omnivo-refresh', async () => {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) return null;
      return authSessionSchema.parse(await response.json());
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

// প্রতিটা API call: Bearer বসানো, 401 হলে একবার refresh করে আবার চেষ্টা, response Zod দিয়ে যাচাই
export async function apiFetch<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  options: RequestOptions = {},
): Promise<z.output<TSchema>> {
  const send = (accessToken: string | null): Promise<Response> => {
    const headers = new Headers();
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      body: options.body === undefined ? null : JSON.stringify(options.body),
    });
  };

  const tokenBefore = sessionStore.getState().accessToken;
  let response = await send(tokenBefore);

  // টোকেন ছিল কিন্তু 401 = মেয়াদ শেষ; টোকেন ছাড়া 401 (যেমন ভুল পাসওয়ার্ড) refresh দিয়ে সারে না
  if (response.status === 401 && tokenBefore) {
    const session = await refreshSession();
    if (!session) {
      sessionStore.getState().signOut();
      throw await toError(response);
    }
    sessionStore.getState().setAccessToken(session.accessToken);
    response = await send(session.accessToken);
  }

  if (!response.ok) throw await toError(response);
  return schema.parse(await response.json());
}

export async function logoutRequest(): Promise<void> {
  await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
}
