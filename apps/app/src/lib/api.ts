import {
  type AuthSession,
  authRoutes,
  buildPath,
  type ErrorCode,
  isErrorCode,
  type Problem,
  problemSchema,
  type RouteDef,
  type RouteRequest,
  type RouteResult,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { sessionStore } from './session-store';

// authRoutes, not the whole `routes` map: this file is in the first page load, and `routes` holds
// every module's schemas. Pages import `routes` themselves, in their own lazy chunks.

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// API-র যেকোনো ব্যর্থতা এই এক আকারে — সার্ভারের problem, নেটওয়ার্ক বন্ধ, বা চুক্তি-ভাঙা উত্তর
export class ApiRequestError extends Error {
  readonly status: number;
  // চেনা code; নতুন সার্ভারের অচেনা code হলে 'unknown_error' (তার লেখা i18n-এ আছে)
  readonly code: ErrorCode;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail);
    this.name = 'ApiRequestError';
    this.status = problem.status;
    this.code = isErrorCode(problem.code) ? problem.code : 'unknown_error';
    this.problem = problem;
  }
}

// সার্ভার problem পাঠায়নি এমন ব্যর্থতা: status 0 = request সার্ভারেই পৌঁছায়নি
function clientError(status: number, code: ErrorCode, detail: string): ApiRequestError {
  return new ApiRequestError({ title: 'Client error', status, detail, code });
}

async function toError(response: Response): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = problemSchema.safeParse(body);
  if (parsed.success) return new ApiRequestError(parsed.data);
  // প্রক্সি/লোড-ব্যালান্সারের নিজের HTML error পেজ (502, 504) — আমাদের আকারে না
  return clientError(
    response.status,
    response.status >= 500 ? 'internal_error' : 'unknown_error',
    `HTTP ${String(response.status)} without a problem body`,
  );
}

// implementation-এর ঢিলা আকার — টাইপ-চেক হয় call()-এর overload-এ, যেখানে R থেকে আসল টাইপ
interface RequestParts {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

async function send(
  route: RouteDef,
  input: RequestParts,
  accessToken: string | null,
): Promise<Response> {
  const url = new URL(`${API_URL}${buildPath(route.path, input.params)}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers = new Headers();
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  if (input.body !== undefined) headers.set('content-type', 'application/json');
  try {
    return await fetch(url, {
      method: route.method,
      headers,
      credentials: 'include',
      body: input.body === undefined ? null : JSON.stringify(input.body),
    });
  } catch {
    // fetch শুধু তখনই throw করে যখন উত্তরই আসেনি (অফলাইন, DNS, CORS)
    throw clientError(0, 'network_error', `${route.method} ${route.path} did not reach the server`);
  }
}

// উত্তর চুক্তির schema দিয়ে parse — টাইপ আসে চুক্তি থেকে, আর সার্ভার চুক্তি ভাঙলে এখানেই ধরা পড়ে।
// S = route-এর response schema-র নিজের টাইপ; R['response'] লিখলে TypeScript তার output
// বের করতে পারত না (unknown দিত), আলাদা generic প্যারামিটার হলে z.output<S> পায়
async function read<S extends z.ZodType>(
  route: RouteDef & { response: S },
  response: Response,
): Promise<z.output<S>> {
  if (!response.ok) throw await toError(response);
  const body: unknown = response.status === 204 ? undefined : await response.json();
  const parsed = route.response.safeParse(body);
  if (!parsed.success) {
    throw clientError(
      response.status,
      'unexpected_response',
      `${route.method} ${route.path} returned a body that breaks its contract`,
    );
  }
  return parsed.data;
}

// একই সময়ে যত request-ই 401 পাক, refresh একবারই যাবে — rotation-এ দ্বিতীয় refresh
// পুরনো cookie পাঠাত আর সার্ভার সেটাকে চুরি ভেবে পুরো session মুছে দিত
let refreshInFlight: Promise<AuthSession | null> | null = null;

export function refreshSession(): Promise<AuthSession | null> {
  refreshInFlight ??= navigator.locks
    // Web Locks: একই ব্রাউজারের একাধিক ট্যাবও একটার পর একটা refresh করবে, একসাথে না।
    // call() না, send() — call() নিজেই 401-এ refresh ডাকে, lock-এর ভেতর থেকে সেটা আটকে যেত
    .request('omnivo-refresh', async () => {
      const response = await send(authRoutes.refresh, {}, null);
      if (!response.ok) return null;
      return read(authRoutes.refresh, response);
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

// চুক্তিতে ইনপুট না থাকলে (বা সব ঐচ্ছিক হলে) দ্বিতীয় argument বাদ দেওয়া যায়।
// `& RequestParts`: caller-এর কাছে কিছু বদলায় না (চুক্তির টাইপ আরও কড়া), কিন্তু TypeScript এতে
// দেখতে পায় যে overload-এর ইনপুট implementation-এর RequestParts-এ বসে — cast ছাড়াই
type CallArgs<R extends RouteDef> =
  Partial<RouteRequest<R>> extends RouteRequest<R>
    ? [input?: RouteRequest<R> & RequestParts]
    : [input: RouteRequest<R> & RequestParts];

// প্রতিটা API call: call(routes.members.list, { query: { sort: '-name' } })।
// path, method, ইনপুট আর উত্তরের টাইপ — সব চুক্তি থেকে; হাতে লেখা URL বা টাইপ নেই।
// Bearer বসানো, 401 হলে একবার refresh করে আবার চেষ্টা
export function call<R extends RouteDef>(route: R, ...args: CallArgs<R>): Promise<RouteResult<R>>;
export async function call(route: RouteDef, input: RequestParts = {}): Promise<unknown> {
  const tokenBefore = sessionStore.getState().accessToken;
  let response = await send(route, input, tokenBefore);

  // টোকেন ছিল কিন্তু 401 = মেয়াদ শেষ; টোকেন ছাড়া 401 (যেমন ভুল পাসওয়ার্ড) refresh দিয়ে সারে না
  if (response.status === 401 && tokenBefore) {
    const session = await refreshSession();
    if (!session) {
      sessionStore.getState().signOut();
      throw await toError(response);
    }
    sessionStore.getState().setAccessToken(session.accessToken);
    response = await send(route, input, session.accessToken);
  }

  return read(route, response);
}
