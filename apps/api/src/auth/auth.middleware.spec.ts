import { Controller, Get, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createAccessTokens } from '@omnivo/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import { AUTH } from '../infra/tokens.js';
import { AuthGuard } from './auth.guard.js';
import { AuthMiddleware } from './auth.middleware.js';
import { Public } from './public.decorator.js';

const tokenConfig = {
  secret: 'test-jwt-secret-that-is-at-least-32-bytes',
  issuer: 'http://localhost:3000',
  audience: 'omnivo-api',
  ttlSeconds: 900,
};
const tokens = createAccessTokens(tokenConfig);

const claims = {
  userId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8e',
  tenantId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8f',
  membershipId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d90',
  roles: ['Owner'],
};

@Controller('probe')
class ProbeController {
  @Get()
  probe(): { tenantId: string; userId: string } {
    return { tenantId: getTenantId(), userId: currentPrincipal().userId };
  }

  @Get('async')
  async probeAsync(): Promise<{ tenantId: string }> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { tenantId: getTenantId() };
  }

  @Public()
  @Get('public')
  open(): { ok: true } {
    return { ok: true };
  }
}

// DB/Redis ছাড়া: AUTH-এর জায়গায় শুধু টোকেন verifier
@Module({
  controllers: [ProbeController],
  providers: [
    { provide: AUTH, useValue: { getPrincipal: tokens.verify } },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('{*splat}');
  }
}

let app: NestFastifyApplication;
let accessToken: string;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  accessToken = (await tokens.sign(claims)).token;
});

afterAll(async () => {
  await app.close();
});

describe('AuthMiddleware + AuthGuard', () => {
  it('carries the principal from the bearer token into the handler', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: claims.tenantId, userId: claims.userId });
  });

  it('keeps the context across an await inside the handler', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe/async',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.json()).toEqual({ tenantId: claims.tenantId });
  });

  it('rejects a request without a token with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(401);
  });

  it('ignores the old x-tenant-id header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': claims.tenantId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with another secret', async () => {
    const forged = createAccessTokens({
      ...tokenConfig,
      secret: 'attacker-secret-that-is-also-32-bytes!!',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: `Bearer ${(await forged.sign(claims)).token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets @Public() routes through without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe/public' });
    expect(res.statusCode).toBe(200);
  });
});
