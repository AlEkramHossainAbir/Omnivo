import {
  Controller,
  Get,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getTenantId } from './tenant-context.js';
import { TenantGuard } from './tenant.guard.js';
import { TenantMiddleware } from './tenant.middleware.js';

@Controller('probe')
class ProbeController {
  @Get()
  @UseGuards(TenantGuard)
  probe(): { tenantId: string } {
    return { tenantId: getTenantId() };
  }

  @Get('async')
  @UseGuards(TenantGuard)
  async probeAsync(): Promise<{ tenantId: string }> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { tenantId: getTenantId() };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('{*splat}');
  }
}

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('TenantMiddleware + TenantGuard', () => {
  const tenantId = '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8e';

  it('carries x-tenant-id into the handler through AsyncLocalStorage', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': tenantId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId });
  });

  it('keeps the context across an await inside the handler', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe/async',
      headers: { 'x-tenant-id': tenantId },
    });
    expect(res.json()).toEqual({ tenantId });
  });

  it('rejects a request without a tenant with 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a malformed tenant id with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': "x' OR 1=1" },
    });
    expect(res.statusCode).toBe(403);
  });
});
