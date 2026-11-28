import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@omnivo/db';
import { Redis } from 'ioredis';

import { createWithTenant } from '../common/tenant/with-tenant.js';
import { DocumentEmailHandler } from '../documents/email.handler.js';
import { DocumentFileHandler } from '../documents/file.handler.js';
import { DocumentFileMaker } from '../documents/file-maker.js';
import type { WorkerConfig } from '../config.js';
import {
  CONFIG,
  COURIERS,
  DB,
  PAYMENT_GATEWAY,
  PAYMENTS_CONFIG,
  REDIS,
  RELAY_DB,
  SHIPPING_CONFIG,
  STORAGE_CONFIG,
  WITH_TENANT,
} from '../infra/tokens.js';
import { PostingService } from '../journal/posting.service.js';
import { createGateway } from '../payments/create-gateway.js';
import { LowStockHandler } from '../inventory/low-stock.handler.js';
import { StockBooksService } from '../inventory/stock-books.service.js';
import { StockPostingService } from '../inventory/stock-posting.service.js';
import { ValueAccess } from '../inventory/value-access.js';
import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
import { MailService } from '../mail/mail.service.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { ShiftVarianceHandler } from '../pos/shift-variance.handler.js';
import { SoldBelowCostHandler } from '../pos/sold-below-cost.handler.js';
import { SoldShortHandler } from '../pos/sold-short.handler.js';
import { ProductImportHandler } from '../products/import.handler.js';
import { ProductsService } from '../products/products.service.js';
import { PermissionService } from '../rbac/permission.service.js';
import { ReportExportHandler } from '../reports/export.handler.js';
import { ReportScheduleEmailHandler } from '../reports/report-schedule-email.handler.js';
import { ReportScheduleRunHandler } from '../reports/report-schedule-run.handler.js';
import { ReportScheduleSweep } from '../reports/report-schedule-sweep.js';
import { BalanceAccess } from '../sales/balance-access.js';
import { CreditService } from '../sales/credit.service.js';
import { CustomersService } from '../sales/customers.service.js';
import { DeliveriesService } from '../sales/deliveries.service.js';
import { InvoicesService } from '../sales/invoices.service.js';
import { ReceiptsService } from '../sales/receipts.service.js';
import { SalesBooksService } from '../sales/sales-books.service.js';
import { SalesOrdersService } from '../sales/sales-orders.service.js';
import { CatalogHandler } from '../setup/catalog.handler.js';
import { ChartHandler } from '../setup/chart.handler.js';
import { ProvisioningHandler } from '../setup/provisioning.handler.js';
import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
import { VerificationEmailHandler } from '../auth/verification-email.handler.js';
import { StorageService } from '../storage/storage.service.js';
import { createCouriers } from '../shipping/create-couriers.js';
import { SMS_MAIL, SMS_SENDER, MailSmsSender } from '../sms/sms-sender.js';
import { SmsQueue } from '../sms/sms-queue.js';
import { StorefrontImageHandler } from '../storefront/image.handler.js';
import { GatewayAccounts } from '../storefront/gateway-accounts.js';
import { OrderConfirmedHandler } from '../storefront/orders/order-confirmed.handler.js';
import { PaymentPaidHandler } from '../storefront/orders/payment-paid.handler.js';
import { ShopPaymentReceipts } from '../storefront/orders/payment-receipts.js';
import { PendingOrderSweep } from '../storefront/orders/pending-order-sweep.js';
import { ShopSalesOrderMaker } from '../storefront/orders/sales-order-maker.js';
import { ShopOrderMoves } from '../storefront/orders/order-moves.js';
import { ShipmentBookingHandler } from '../storefront/shipping/booking.handler.js';
import { ShopCodReceipts } from '../storefront/shipping/cod-receipts.js';
import { ShipmentNews } from '../storefront/shipping/shipment-news.js';
import { ShipmentPoll } from '../storefront/shipping/shipment-poll.js';
import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
import { EventHandlers } from './handlers.js';
import { JobRunner } from './job-runner.js';
import { OutboxRelay } from './outbox-relay.js';
import { Queues } from './queues.js';
import { SmsRunner } from './sms-runner.js';

// The worker process: no HTTP server, no controllers — the relay and the queue workers. It does
// not import InfraModule: that one brings the API's things (auth, the permission cache) which the
// worker neither needs nor should hold the secrets for. Storage it does need from step 11, to save
// the report files it writes — so it gets StorageService alone, with the storage settings only.
@Module({})
export class WorkerModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELAY_DB) private readonly relayDb: Db,
    @Inject(REDIS) private readonly redis: Redis,
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
        VerificationEmailHandler,
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
        // Step 20b: the bell for a shift whose count was far from the expected cash
        ShiftVarianceHandler,
        // Cost floor: the bell for a POS sale below the buying price
        SoldBelowCostHandler,
        // Step 18a: the hourly job also prunes the sync change log, on the relay's pool
        SyncLogCleanup,
        // Step 21c: the 5-minute sweep for due report emails (both pools), one run of a schedule,
        // and the email that carries each person's file
        ReportScheduleSweep,
        ReportScheduleRunHandler,
        ReportScheduleEmailHandler,
        // Step 26g: a shop photo's WebP files
        StorefrontImageHandler,
        // Step 27a: the shop's orders. The bell for a confirmed one, the sweep for the ones that
        // never got their code, and the SMS queue's consumer with its sender (Mailpit until the
        // real provider: that one line changes then)
        OrderConfirmedHandler,
        PendingOrderSweep,
        { provide: SMS_SENDER, useClass: MailSmsSender },
        // The SMS's own mail server (SMS_SMTP_URL, Mailpit), so a phone code never goes to the
        // real email service. Same from address and timeouts as the emails. A factory instance
        // still gets its shutdown hook, so this transport closes with the worker
        {
          provide: SMS_MAIL,
          useFactory: () =>
            new MailService({ mail: { url: config.sms.mailUrl, from: config.mail.from } }),
        },
        SmsRunner,
        // Step 27b: a confirmed order's customer and sales order, made by OrderConfirmedHandler
        // with the services the ERP's screens use, so a shop sale follows the same rules
        ShopSalesOrderMaker,
        CustomersService,
        SalesOrdersService,
        ProductsService,
        // What those services ask for. CreditService and BalanceAccess read a member's permissions,
        // which the shop's sales order never asks (no member; 'storefront_order' skips it), so this
        // Redis client is never used here: lazyConnect, and it never opens a connection
        CreditService,
        BalanceAccess,
        PermissionService,
        // Step 27d: the money receipt of a paid try, and the sweep's look at the gateway before it
        // drops an unpaid online order
        { provide: PAYMENTS_CONFIG, useValue: config.payments },
        { provide: PAYMENT_GATEWAY, useFactory: () => createGateway(config.payments) },
        GatewayAccounts,
        PaymentPaidHandler,
        ShopPaymentReceipts,
        ReceiptsService,
        SalesBooksService,
        PostingService,
        // Step 28a: the couriers. The booking job, the 15-minute poll, and what the courier's
        // news needs to move an order: Shipped and Delivered with the buttons' own code
        // (ShopOrderMoves), whose invoice needs the sales and stock services below, and the SMS
        // queue's producer for the "picked up" SMS (the API's own SmsQueue: it reads only
        // redisUrl from the config)
        { provide: SHIPPING_CONFIG, useValue: config.shipping },
        { provide: COURIERS, useFactory: () => createCouriers(config.shipping) },
        ShipmentBookingHandler,
        ShipmentPoll,
        ShipmentNews,
        ShopOrderMoves,
        // Step 28b: the courier's "delivered" makes the rider's COD receipt too
        ShopCodReceipts,
        InvoicesService,
        DeliveriesService,
        StockPostingService,
        StockBooksService,
        ValueAccess,
        SmsQueue,
        { provide: REDIS, useFactory: () => new Redis(config.redisUrl, { lazyConnect: true }) },
      ],
    };
  }

  // Last: the relay and the queue workers have stopped in beforeApplicationShutdown by now
  async onApplicationShutdown(): Promise<void> {
    // disconnect(), not quit(): quit() sends a command, which would open the connection first
    this.redis.disconnect();
    await Promise.all([this.db.$client.end(), this.relayDb.$client.end()]);
  }
}
