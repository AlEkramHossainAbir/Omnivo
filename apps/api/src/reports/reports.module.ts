import { Module } from '@nestjs/common';

import { JournalModule } from '../journal/journal.module.js';
import { FiscalYearsService } from './fiscal-years.service.js';
import { ReportExportsService } from './report-exports.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

// The financial statements, the year-end close and the exports. JournalModule gives
// PostingService: the closing entry goes into the books the same way as every other entry.
@Module({
  imports: [JournalModule],
  controllers: [ReportsController],
  providers: [ReportsService, FiscalYearsService, ReportExportsService],
})
export class ReportsModule {}
