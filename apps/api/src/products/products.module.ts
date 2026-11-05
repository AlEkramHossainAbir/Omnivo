import { Module } from '@nestjs/common';

import { NumberingModule } from '../numbering/numbering.module.js';
import { ProductCategoriesController } from './product-categories.controller.js';
import { ProductCategoriesService } from './product-categories.service.js';
import { ProductImportsService } from './product-imports.service.js';
import { ProductImportsController, ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { UnitsController } from './units.controller.js';
import { UnitsService } from './units.service.js';

// Products, their units and categories, and CSV imports (step 12). NumberingModule gives the
// product codes (P-00042). The import's worker half (import.handler.ts) is wired in
// worker/worker.module.ts, like every handler.
@Module({
  imports: [NumberingModule],
  controllers: [
    UnitsController,
    ProductCategoriesController,
    ProductsController,
    ProductImportsController,
  ],
  providers: [UnitsService, ProductCategoriesService, ProductsService, ProductImportsService],
})
export class ProductsModule {}
