import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { PosController } from './pos.controller.js';
import { PosCashReasonsService } from './pos-cash-reasons.service.js';
import { PosRegistersService } from './pos-registers.service.js';
import { PosSalesService } from './pos-sales.service.js';
import { PosShiftsController } from './pos-shifts.controller.js';
import { PosShiftsService } from './pos-shifts.service.js';

// Step 20a: the point of sale. InventoryModule gives a sale what every stock document uses:
// StockPostingService moves the stock (planSale() first, decision 15), StockBooksService books
// the sale and its cost in one entry. PosSalesService is exported for the sync's push, which is
// the only place a sale is written (SyncModule imports this module). The "Sold short" bell's
// worker half (sold-short.handler.ts) is wired in worker/worker.module.ts, like every handler.
// Step 20b: the shifts and the pay in / pay out reasons. A shift's entries touch only money, so
// PosShiftsService posts them with the journal's PostingService (JournalModule). It is exported
// for the push too, which writes a shift's three commands; the variance bell's handler is wired
// in the worker like the sold-short one.
@Module({
  imports: [InventoryModule, JournalModule],
  controllers: [PosController, PosShiftsController],
  providers: [PosRegistersService, PosSalesService, PosCashReasonsService, PosShiftsService],
  exports: [PosSalesService, PosShiftsService],
})
export class PosModule {}
