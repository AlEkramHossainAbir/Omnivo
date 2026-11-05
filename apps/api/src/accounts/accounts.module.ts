import { Module } from '@nestjs/common';

import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';

// The chart of accounts. Its starting accounts come from the worker (setup/seed-chart.ts); this
// module is what people do with them afterwards.
@Module({
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
