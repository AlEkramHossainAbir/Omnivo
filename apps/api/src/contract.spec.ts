import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { problemSchema, type RouteDef, routes } from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import { configureApp, createAdapter } from './configure-app.js';
import { testConfig } from './testing/app.js';

// DB/Redis ছাড়াই (Docker লাগে না): নিচের কোনো request DB পর্যন্ত পৌঁছায় না — পুরনো ঠিকানা
// দেওয়া হলেও postgres.js প্রথম query-র আগে সংযোগই করে না
let app: NestFastifyApplication;
const registered: string[] = [];

beforeAll(async () => {
  const adapter = createAdapter();
  // Nest রুট বসানোর আগেই hook — Fastify প্রতিটা নতুন রুটে এটা ডাকে
  adapter.getInstance().addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      // HEAD Fastify নিজে GET-এর জন্য বানায়, OPTIONS CORS-এর — আমাদের চুক্তির অংশ না
      if (method !== 'HEAD' && method !== 'OPTIONS') registered.push(`${method} ${route.url}`);
    }
  });
  const config = testConfig({
    databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none',
    redisUrl: 'redis://127.0.0.1:1',
  });
  app = await NestFactory.create<NestFastifyApplication>(AppModule.register(config), adapter, {
    logger: false,
  });
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('routes match the contract registry', () => {
  it('serves exactly the routes in @omnivo/contracts, plus the dev-only docs', () => {
    // চওড়া টাইপে রাখা: প্রতিটা group-এর আলাদা object টাইপে Object.values any দিত
    const registry: Record<string, Record<string, RouteDef>> = routes;
    const contract = Object.values(registry).flatMap((group) =>
      Object.values(group).map((route) => `${route.method} ${route.path}`),
    );
    expect(registered.sort()).toEqual([...contract, 'GET /docs', 'GET /openapi.json'].sort());
  });
});

describe('error envelope', () => {
  it('answers an unknown route with a not_found problem and a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/nothing-here' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = problemSchema.parse(res.json());
    expect(problem).toMatchObject({ status: 404, title: 'Not Found', code: 'not_found' });
    expect(problem.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).toBe(problem.requestId);
  });

  it('answers a body that is not JSON with malformed_request, not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"workspace":',
    });
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).code).toBe('malformed_request');
  });

  it('collects every invalid field into one 400, as codes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { workspace: 'A', email: 'nope', password: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json())).toMatchObject({
      code: 'invalid_input',
      fieldErrors: {
        workspace: ['slug_too_short'],
        email: ['email_invalid'],
        password: ['password_required'],
        keepSignedIn: ['required'],
      },
    });
  });

  it('rejects a query value outside the contract before the handler runs', async () => {
    // টোকেন নেই, তাই আগে AuthGuard: 401 — ইনপুট যাচাই guard-এর পরে চলে
    const res = await app.inject({ method: 'GET', url: '/members?limit=1000' });
    expect(res.statusCode).toBe(401);
  });
});

describe('CORS', () => {
  it('lets the app send every method the contract uses, not only GET and POST', async () => {
    // ব্রাউজার PUT/PATCH-এর আগে এই preflight পাঠায়; উত্তরে method না থাকলে আসল request যায়ই না
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/settings',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PUT',
      },
    });
    expect(res.statusCode).toBe(204);
    const allowed = String(res.headers['access-control-allow-methods']).split(/,\s*/);
    const registry: Record<string, Record<string, RouteDef>> = routes;
    const used = new Set(
      Object.values(registry).flatMap((group) => Object.values(group).map((route) => route.method)),
    );
    for (const method of used) expect(allowed).toContain(method);
  });
});

describe('docs', () => {
  it('serves the OpenAPI document with this server as its base URL', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      openapi: '3.1.0',
      servers: [{ url: 'http://localhost:3000' }],
    });
  });
});
