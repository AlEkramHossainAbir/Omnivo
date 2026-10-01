import { Module } from '@nestjs/common';

import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { BooksController } from './books.controller.js';
import { JournalController } from './journal.controller.js';
import { JournalService } from './journal.service.js';
import { LedgerService } from './ledger.service.js';
import { OpeningBalancesService } from './opening-balances.service.js';
import { PeriodLockService } from './period-lock.service.js';
import { PostingService } from './posting.service.js';

// The double-entry journal. PostingService is exported: every later module that posts (sales,
// purchase, inventory) imports this module and calls postNew() in its own transaction.
@Module({
  imports: [NumberingModule, RbacModule],
  controllers: [JournalController, BooksController],
  providers: [
    JournalService,
    LedgerService,
    OpeningBalancesService,
    PeriodLockService,
    PostingService,
  ],
  exports: [PostingService],
})
export class JournalModule {}
