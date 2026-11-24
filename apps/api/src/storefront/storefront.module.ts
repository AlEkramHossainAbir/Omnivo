import { Module } from '@nestjs/common';

import { AttachmentsModule } from '../attachments/attachments.module.js';
import { ProductsModule } from '../products/products.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { StorefrontAppearanceService } from './admin/appearance.service.js';
import { StorefrontCategoriesService } from './admin/categories.service.js';
import { StorefrontCollectionsService } from './admin/collections.service.js';
import { StorefrontCouponsService } from './admin/coupons.service.js';
import { StorefrontImagesService } from './admin/images.service.js';
import { StorefrontListingsService } from './admin/listings.service.js';
import { StorefrontPagesService } from './admin/pages.service.js';
import { StorefrontSettingsService } from './admin/settings.service.js';
import { StorefrontAdminController } from './admin/storefront-admin.controller.js';
import { StorefrontAppearanceController } from './admin/storefront-appearance.controller.js';
import { StorefrontCouponsController } from './admin/storefront-coupons.controller.js';
import { StorefrontPaymentGatewayService } from './admin/payment-gateway.service.js';
import { StorefrontPaymentsController } from './admin/storefront-payments.controller.js';
import { GatewayAccounts } from './gateway-accounts.js';
import { PaymentPages } from './orders/payment-pages.js';
import { ShopPaymentReceipts } from './orders/payment-receipts.js';
import { ShopPaymentsService } from './orders/shop-payments.service.js';
import { SmsQueue } from '../sms/sms-queue.js';
import { ShopLimits } from './orders/shop-limits.js';
import { ShopOrdersController } from './orders/shop-orders.controller.js';
import { ShopOrdersService } from './orders/shop-orders.service.js';
import { ShopSalesOrderMaker } from './orders/sales-order-maker.js';
import { StorefrontOrdersController } from './orders/storefront-orders.controller.js';
import { StorefrontOrdersService } from './orders/storefront-orders.service.js';
import { PublicStorefrontController } from './public-storefront.controller.js';
import { PublicStorefrontService } from './public-storefront.service.js';
import { ShopOrderMoves } from './orders/order-moves.js';
import { CourierAccountsController } from './shipping/courier-accounts.controller.js';
import { CourierAccountsService } from './shipping/courier-accounts.service.js';
import { CourierWebhooks } from './shipping/courier-webhooks.js';
import { ShipmentNews } from './shipping/shipment-news.js';
import { ShopDb } from './shop-db.js';

// Step 26f: the online shop's side of the API: the public reads (/public/v1). Step 26g adds the
// ERP's Storefront screens' routes (admin/), behind storefront.manage. The two halves share the
// tables and the photo addresses (media.ts), never a service: the public half runs as
// omnivo_public in a read-only transaction, the admin half as the signed-in member. Step 26h adds
// Appearance and the text pages, with their own controller (the contract's own group). Step 27a
// adds the shop server's order routes (orders/), as omnivo_shop, and the SMS they send. Step 27b
// adds Shop orders, the ERP's side of them (orders/storefront-orders.*): its moves make sales
// documents with the sales services (SalesModule), and the "Delivery charge" service with
// ProductsService. Step 27c adds Coupons (admin/coupons.service.ts, its own controller); the
// quote and placing an order read a coupon through coupon-sql.ts, never through that service, for
// the reason above. Step 27d adds paying online: the shop's payment routes (orders/shop-payments.*,
// as omnivo_shop), the Payment card (admin/payment-gateway.*), and the money receipt of a paid try
// (orders/payment-receipts.ts), which "Make the receipt" shares with the worker. The gateway itself
// comes from InfraModule (PAYMENT_GATEWAY). Step 28a adds couriers (shipping/): the Shop couriers
// page and the courier's webhook (one controller), the parcels of a shop order (shipping/
// shipments.ts, used by the order moves), and the courier's news, which moves an order with the
// buttons' own code (orders/order-moves.ts). The adapters come from InfraModule (COURIERS); the
// booking job and the poll run in the worker
@Module({
  imports: [AttachmentsModule, SalesModule, ProductsModule],
  controllers: [
    PublicStorefrontController,
    ShopOrdersController,
    StorefrontAdminController,
    StorefrontAppearanceController,
    StorefrontOrdersController,
    StorefrontCouponsController,
    StorefrontPaymentsController,
    CourierAccountsController,
  ],
  providers: [
    ShopDb,
    PublicStorefrontService,
    ShopOrdersService,
    ShopLimits,
    SmsQueue,
    StorefrontSettingsService,
    StorefrontCategoriesService,
    StorefrontImagesService,
    StorefrontListingsService,
    StorefrontCollectionsService,
    StorefrontAppearanceService,
    StorefrontPagesService,
    ShopSalesOrderMaker,
    StorefrontOrdersService,
    StorefrontCouponsService,
    GatewayAccounts,
    PaymentPages,
    ShopPaymentsService,
    ShopPaymentReceipts,
    StorefrontPaymentGatewayService,
    ShopOrderMoves,
    CourierAccountsService,
    CourierWebhooks,
    ShipmentNews,
  ],
})
export class StorefrontModule {}
