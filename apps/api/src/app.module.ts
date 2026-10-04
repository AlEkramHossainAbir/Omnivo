import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AccountsModule } from './accounts/accounts.module.js';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthMiddleware } from './auth/auth.middleware.js';
import { AuthModule } from './auth/auth.module.js';
import { BranchesModule } from './branches/branches.module.js';
import { CustomFieldsModule } from './custom-fields/custom-fields.module.js';
import { ContractInterceptor } from './common/http/contract.interceptor.js';
import { ProblemFilter } from './common/http/problem.filter.js';
import { RequestContextMiddleware } from './common/request/request-context.js';
import type { Config } from './config.js';
import { DocsController } from './docs/docs.controller.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { InvitationsModule } from './invitations/invitations.module.js';
import { JournalModule } from './journal/journal.module.js';
import { MembersModule } from './members/members.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { NumberingModule } from './numbering/numbering.module.js';
import { PermissionGuard } from './rbac/permission.guard.js';
import { ProductsModule } from './products/products.module.js';
import { RbacModule } from './rbac/rbac.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { RolesModule } from './roles/roles.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { SetupModule } from './setup/setup.module.js';

@Module({})
export class AppModule implements NestModule {
  // config বাইরে থেকে আসে: main.ts-এ process.env থেকে, টেস্টে Testcontainers-এর URL থেকে
  static register(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule.register(config),
        RbacModule,
        AuthModule,
        MembersModule,
        InvitationsModule,
        RolesModule,
        SettingsModule,
        BranchesModule,
        NumberingModule,
        AuditModule,
        AttachmentsModule,
        SetupModule,
        NotificationsModule,
        AccountsModule,
        JournalModule,
        ReportsModule,
        CustomFieldsModule,
        ProductsModule,
      ],
      controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
      providers: [
        // ক্রম গুরুত্বপূর্ণ: আগে "কে" (AuthGuard → 401), তারপর "কী করতে পারে" (PermissionGuard → 403)
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        // প্রতিটা response চুক্তির schema দিয়ে যাচাই আর অচেনা ফিল্ড ছাঁটাই
        { provide: APP_INTERCEPTOR, useClass: ContractInterceptor },
        // প্রতিটা error একই আকারে: RFC 9457 problem + আমাদের code
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // ক্রম: আগে request-এর পরিচয় (id, IP) — তারপর টোকেন। দুটোই সব রুটে, public-এও (লগইনের audit)
    consumer.apply(RequestContextMiddleware, AuthMiddleware).forRoutes('{*splat}');
  }
}
