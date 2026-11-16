import { Module } from '@nestjs/common';

import { AttachmentsModule } from '../attachments/attachments.module.js';
import { StorefrontCategoriesService } from './admin/categories.service.js';
import { StorefrontImagesService } from './admin/images.service.js';
import { StorefrontListingsService } from './admin/listings.service.js';
import { StorefrontSettingsService } from './admin/settings.service.js';
import { StorefrontAdminController } from './admin/storefront-admin.controller.js';
import { PublicStorefrontController } from './public-storefront.controller.js';
import { PublicStorefrontService } from './public-storefront.service.js';
import { ShopDb } from './shop-db.js';

// Step 26f: the online shop's side of the API: the public reads (/public/v1). Step 26g adds the
// ERP's Storefront screens' routes (admin/), behind storefront.manage. The two halves share the
// tables and the photo addresses (media.ts), never a service: the public half runs as
// omnivo_public in a read-only transaction, the admin half as the signed-in member
@Module({
  imports: [AttachmentsModule],
  controllers: [PublicStorefrontController, StorefrontAdminController],
  providers: [
    ShopDb,
    PublicStorefrontService,
    StorefrontSettingsService,
    StorefrontCategoriesService,
    StorefrontImagesService,
    StorefrontListingsService,
  ],
})
export class StorefrontModule {}
