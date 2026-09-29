import { Module } from '@nestjs/common';

import { NumberingController } from './numbering.controller.js';
import { NumberingService } from './numbering.service.js';

// NumberingService export: ধাপ ১০ (journal) আর ১৫ (ইনভয়েস)-এর মডিউল এটা import করে next() ডাকবে
@Module({
  controllers: [NumberingController],
  providers: [NumberingService],
  exports: [NumberingService],
})
export class NumberingModule {}
