import { Module } from '@nestjs/common';

import { AttachmentsModule } from '../attachments/attachments.module.js';
import { ProductsModule } from '../products/products.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { StorefrontAppearanceService } from './admin/appearance.service.js';
import { StorefrontCategoriesService } from './admin/categories.service.js';
import { StorefrontCollectionsService } from './admin/collections.service.js';
import { StorefrontImagesService } from './admin/images.service.js';
import { StorefrontListingsService } from './admin/listings.service.js';
import { StorefrontPagesService } from './admin/pages.service.js';
import { StorefrontSettingsService } from './admin/settings.service.js';
import { StorefrontAdminController } from './admin/storefront-admin.controller.js';
import { StorefrontAppearanceController } from './admin/storefront-appearance.controller.js';
import { SmsQueue } from '../sms/sms-queue.js';
import { ShopLimits } from './orders/shop-limits.js';
import { ShopOrdersController } from './orders/shop-orders.controller.js';
import { ShopOrdersService } from './orders/shop-orders.service.js';
import { ShopSalesOrderMaker } from './orders/sales-order-maker.js';
import { StorefrontOrdersController } from './orders/storefront-orders.controller.js';
import { StorefrontOrdersService } from './orders/storefront-orders.service.js';
import { PublicStorefrontController } from './public-storefront.controller.js';
import { PublicStorefrontService } from './public-storefront.service.js';
import { ShopDb } from './shop-db.js';

// Step 26f: the online shop's side of the API: the public reads (/public/v1). Step 26g adds the
// ERP's Storefront screens' routes (admin/), behind storefront.manage. The two halves share the
// tables and the photo addresses (media.ts), never a service: the public half runs as
// omnivo_public in a read-only transaction, the admin half as the signed-in member. Step 26h adds
// Appearance and the text pages, with their own controller (the contract's own group). Step 27a
// adds the shop server's order routes (orders/), as omnivo_shop, and the SMS they send. Step 27b
// adds Shop orders, the ERP's side of them (orders/storefront-orders.*): its moves make sales
// documents with the sales services (SalesModule), and the "Delivery charge" service with
// ProductsService
@Module({
  imports: [AttachmentsModule, SalesModule, ProductsModule],
  controllers: [
    PublicStorefrontController,
    ShopOrdersController,
    StorefrontAdminController,
    StorefrontAppearanceController,
    StorefrontOrdersController,
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
  ],
})
export class StorefrontModule {}
