import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@omnivo/db';

import { createWithTenant } from '../common/tenant/with-tenant.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG, DB, RELAY_DB, WITH_TENANT } from '../infra/tokens.js';
import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
import { MailService } from '../mail/mail.service.js';
import { ProvisioningHandler } from '../setup/provisioning.handler.js';
import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
import { EventHandlers } from './handlers.js';
import { JobRunner } from './job-runner.js';
import { OutboxRelay } from './outbox-relay.js';
import { Queues } from './queues.js';

// The worker process: no HTTP server, no controllers — the relay and the queue workers. It does
// not import InfraModule: that one brings the API's things (auth, S3 storage, the permission
// cache) which the worker neither needs nor should hold the secrets for.
@Module({})
export class WorkerModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELAY_DB) private readonly relayDb: Db,
  ) {}

  static register(config: WorkerConfig): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: CONFIG, useValue: config },
        // The jobs' pool: omnivo_app, tenant context per transaction — exactly like the API
        { provide: DB, useFactory: () => createDb(config.databaseUrl) },
        // The relay's pool: omnivo_worker. Two connections: one for the relay, one for the cleanup
        { provide: RELAY_DB, useFactory: () => createDb(config.relayDatabaseUrl, { max: 2 }) },
        { provide: WITH_TENANT, inject: [DB], useFactory: (db: Db) => createWithTenant(db) },
        MailService,
        Queues,
        OutboxRelay,
        JobRunner,
        EventHandlers,
        WelcomeEmailHandler,
        ProvisioningHandler,
        InvitationEmailHandler,
        MemberJoinedHandler,
      ],
    };
  }

  // Last: the relay and the queue workers have stopped in beforeApplicationShutdown by now
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.db.$client.end(), this.relayDb.$client.end()]);
  }
}
