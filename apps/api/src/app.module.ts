import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';

import { TenantMiddleware } from './common/tenant/tenant.middleware.js';
import { HealthController } from './health/health.controller.js';

@Module({
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('{*splat}');
  }
}
