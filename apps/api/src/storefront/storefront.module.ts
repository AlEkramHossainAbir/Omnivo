import { Module } from '@nestjs/common';

import { PublicStorefrontController } from './public-storefront.controller.js';
import { PublicStorefrontService } from './public-storefront.service.js';
import { ShopDb } from './shop-db.js';

// Step 26f: the online shop's side of the API. Today only the public reads (/public/v1); step 26g
// adds the ERP's Storefront screens' routes here, behind storefront.manage
@Module({
  controllers: [PublicStorefrontController],
  providers: [ShopDb, PublicStorefrontService],
})
export class StorefrontModule {}
