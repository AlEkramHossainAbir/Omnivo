import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module.js';
import { PosController } from './pos.controller.js';
import { PosRegistersService } from './pos-registers.service.js';
import { PosSalesService } from './pos-sales.service.js';

// Step 20a: the point of sale. InventoryModule gives a sale what every stock document uses:
// StockPostingService moves the stock (planSale() first, decision 15), StockBooksService books
// the sale and its cost in one entry. PosSalesService is exported for the sync's push, which is
// the only place a sale is written (SyncModule imports this module). The "Sold short" bell's
// worker half (sold-short.handler.ts) is wired in worker/worker.module.ts, like every handler.
@Module({
  imports: [InventoryModule],
  controllers: [PosController],
  providers: [PosRegistersService, PosSalesService],
  exports: [PosSalesService],
})
export class PosModule {}
