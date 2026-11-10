import { Module } from '@nestjs/common';

import { JournalModule } from '../journal/journal.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { FiscalYearsService } from './fiscal-years.service.js';
import { ReportExportsService } from './report-exports.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { TradeReportsService } from './trade-reports.service.js';

// The financial statements, the year-end close and the exports; since step 21b the sales and
// purchase reports and the agings. JournalModule gives PostingService: the closing entry goes into
// the books the same way as every other entry. RbacModule gives PermissionService: the cost columns
// and each kind of export check their own permission.
@Module({
  imports: [JournalModule, RbacModule],
  controllers: [ReportsController],
  providers: [ReportsService, FiscalYearsService, ReportExportsService, TradeReportsService],
})
export class ReportsModule {}
