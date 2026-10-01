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
import { AUTH, CONFIG, DB, REDIS, STORAGE_CONFIG, WITH_TENANT, WITH_USER } from './tokens.js';

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
      ],
      exports: [CONFIG, DB, WITH_TENANT, WITH_USER, REDIS, AUTH, StorageService],
    };
  }

  // app.close() বা SIGTERM-এ pool আর Redis connection বন্ধ — নাহলে process ঝুলে থাকে
  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.db.$client.end();
  }
}
