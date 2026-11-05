import { Module } from '@nestjs/common';

import { JournalModule } from '../journal/journal.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { StockAccountsService } from './stock-accounts.service.js';
import { StockAdjustmentsService } from './stock-adjustments.service.js';
import { StockBooksService } from './stock-books.service.js';
import {
  StockAdjustmentsController,
  StockController,
  StockTransfersController,
} from './stock.controller.js';
import { StockPostingService } from './stock-posting.service.js';
import { StockRevaluationsService } from './stock-revaluations.service.js';
import { StockTransfersService } from './stock-transfers.service.js';
import { StockService } from './stock.service.js';
import { StockAccountsController, StockRevaluationsController } from './valuation.controller.js';
import { ValueAccess } from './value-access.js';
import { WarehousesController } from './warehouses.controller.js';
import { WarehousesService } from './warehouses.service.js';

// Warehouses and the stock ledger (step 13), and what the stock is worth (step 14).
// StockPostingService and StockBooksService are exported: purchases, sales and POS (steps 15–20)
// import this module, call post() for the stock and its values, and write their own journal entry
// in the same transaction, the way every module that posts to the books uses the journal's
// PostingService. ValueAccess too (step 15b): a delivery shows what its goods cost only to
// someone with inventory.stock.value, like every stock document. JournalModule gives
// StockBooksService that PostingService; RbacModule gives ValueAccess the permission check. The
// low-stock alert's worker half (low-stock.handler.ts) is wired in worker/worker.module.ts, like
// every handler.
@Module({
  imports: [NumberingModule, JournalModule, RbacModule],
  controllers: [
    WarehousesController,
    StockController,
    StockAdjustmentsController,
    StockTransfersController,
    StockRevaluationsController,
    StockAccountsController,
  ],
  providers: [
    WarehousesService,
    StockService,
    StockPostingService,
    StockBooksService,
    StockAdjustmentsService,
    StockTransfersService,
    StockRevaluationsService,
    StockAccountsService,
    ValueAccess,
  ],
  exports: [StockPostingService, StockBooksService, ValueAccess],
})
export class InventoryModule {}
