import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createAuth } from '@omnivo/auth';
import { createDb, type Db } from '@omnivo/db';
import { Redis } from 'ioredis';

import { createWithTenant } from '../common/tenant/with-tenant.js';
import { createWithUser } from '../common/tenant/with-user.js';
import type { Config } from '../config.js';
import { StorageService } from '../storage/storage.service.js';
import { createGateway } from '../payments/create-gateway.js';
import { createCouriers } from '../shipping/create-couriers.js';
import {
  AUTH,
  CONFIG,
  COURIERS,
  DB,
  PAYMENT_GATEWAY,
  PAYMENTS_CONFIG,
  REDIS,
  SHIPPING_CONFIG,
  STORAGE_CONFIG,
  WITH_TENANT,
  WITH_USER,
} from './tokens.js';

function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    // Redis বন্ধ থাকলে command queue-তে জমে থাকবে না, সাথে সাথে fail করবে —
    // permission cache তখন DB-তে fallback করে, request ঝুলে থাকে না
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  const logger = new Logger('Redis');
  redis.on('error', (error: Error) => {
    // localhost-এ ::1 আর 127.0.0.1 দুটোই ব্যর্থ হলে AggregateError আসে, যার message ফাঁকা —
    // তখন code (ECONNREFUSED) দেখানো, আর কী করতে হবে সেটা বলা
    const code = 'code' in error ? String(error.code) : error.name;
    logger.warn(error.message || `Can't reach Redis (${code}). Start it with pnpm db:up.`);
  });
  return redis;
}

@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  static register(config: Config): DynamicModule {
    return {
      module: InfraModule,
      global: true,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB, useFactory: () => createDb(config.databaseUrl) },
        { provide: WITH_TENANT, inject: [DB], useFactory: (db: Db) => createWithTenant(db) },
        { provide: WITH_USER, inject: [DB], useFactory: (db: Db) => createWithUser(db) },
        { provide: REDIS, useFactory: () => createRedis(config.redisUrl) },
        { provide: AUTH, inject: [DB], useFactory: (db: Db) => createAuth({ db, ...config.auth }) },
        { provide: STORAGE_CONFIG, useValue: config.storage },
        StorageService,
        // Step 27d: the gateway for the shop's payments and the Payment card's test
        { provide: PAYMENTS_CONFIG, useValue: config.payments },
        { provide: PAYMENT_GATEWAY, useFactory: () => createGateway(config.payments) },
        // Step 28a: the couriers, for a webhook and "Test connection" (the worker books and polls)
        { provide: SHIPPING_CONFIG, useValue: config.shipping },
        { provide: COURIERS, useFactory: () => createCouriers(config.shipping) },
      ],
      exports: [
        CONFIG,
        DB,
        WITH_TENANT,
        WITH_USER,
        REDIS,
        AUTH,
        StorageService,
        PAYMENTS_CONFIG,
        PAYMENT_GATEWAY,
        SHIPPING_CONFIG,
        COURIERS,
      ],
    };
  }

  // app.close() বা SIGTERM-এ pool আর Redis connection বন্ধ — নাহলে process ঝুলে থাকে
  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.db.$client.end();
  }
}
