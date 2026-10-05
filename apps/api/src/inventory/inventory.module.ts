import { Module } from '@nestjs/common';

import { NumberingModule } from '../numbering/numbering.module.js';
import { StockAdjustmentsService } from './stock-adjustments.service.js';
import {
  StockAdjustmentsController,
  StockController,
  StockTransfersController,
} from './stock.controller.js';
import { StockPostingService } from './stock-posting.service.js';
import { StockTransfersService } from './stock-transfers.service.js';
import { StockService } from './stock.service.js';
import { WarehousesController } from './warehouses.controller.js';
import { WarehousesService } from './warehouses.service.js';

// Warehouses and the stock ledger (step 13). StockPostingService is exported: purchases, sales and
// POS (steps 15–20) import this module and call post() in their own transaction, the way every
// module that posts to the books uses the journal's PostingService. The low-stock alert's worker
// half (low-stock.handler.ts) is wired in worker/worker.module.ts, like every handler.
@Module({
  imports: [NumberingModule],
  controllers: [
    WarehousesController,
    StockController,
    StockAdjustmentsController,
    StockTransfersController,
  ],
  providers: [
    WarehousesService,
    StockService,
    StockPostingService,
    StockAdjustmentsService,
    StockTransfersService,
  ],
  exports: [StockPostingService],
})
export class InventoryModule {}
