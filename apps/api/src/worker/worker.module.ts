import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@omnivo/db';

import { createWithTenant } from '../common/tenant/with-tenant.js';
import { DocumentEmailHandler } from '../documents/email.handler.js';
import { DocumentFileHandler } from '../documents/file.handler.js';
import { DocumentFileMaker } from '../documents/file-maker.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG, DB, RELAY_DB, STORAGE_CONFIG, WITH_TENANT } from '../infra/tokens.js';
import { LowStockHandler } from '../inventory/low-stock.handler.js';
import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
import { MailService } from '../mail/mail.service.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { SoldShortHandler } from '../pos/sold-short.handler.js';
import { ProductImportHandler } from '../products/import.handler.js';
import { ReportExportHandler } from '../reports/export.handler.js';
import { CatalogHandler } from '../setup/catalog.handler.js';
import { ChartHandler } from '../setup/chart.handler.js';
import { ProvisioningHandler } from '../setup/provisioning.handler.js';
import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
import { StorageService } from '../storage/storage.service.js';
import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
import { EventHandlers } from './handlers.js';
import { JobRunner } from './job-runner.js';
import { OutboxRelay } from './outbox-relay.js';
import { Queues } from './queues.js';

// The worker process: no HTTP server, no controllers — the relay and the queue workers. It does
// not import InfraModule: that one brings the API's things (auth, the permission cache) which the
// worker neither needs nor should hold the secrets for. Storage it does need from step 11, to save
// the report files it writes — so it gets StorageService alone, with the storage settings only.
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
        { provide: STORAGE_CONFIG, useValue: config.storage },
        StorageService,
        MailService,
        Queues,
        OutboxRelay,
        JobRunner,
        EventHandlers,
        WelcomeEmailHandler,
        ProvisioningHandler,
        InvitationEmailHandler,
        MemberJoinedHandler,
        ChartHandler,
        ReportExportHandler,
        CatalogHandler,
        // The import gives new products their codes, like the API does
        NumberingService,
        ProductImportHandler,
        LowStockHandler,
        StockAccountsHandler,
        TaxRatesHandler,
        // Step 16: the PDF (drawn from the model the API stored) and the email it goes out with
        DocumentFileMaker,
        DocumentFileHandler,
        DocumentEmailHandler,
        // Step 20a: the bell for a POS sale that took stock below zero
        SoldShortHandler,
        // Step 18a: the hourly job also prunes the sync change log, on the relay's pool
        SyncLogCleanup,
      ],
    };
  }

  // Last: the relay and the queue workers have stopped in beforeApplicationShutdown by now
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.db.$client.end(), this.relayDb.$client.end()]);
  }
}
