import { Inject, Injectable } from '@nestjs/common';
import type {
  StockMovementFilter,
  StockMovementReport,
  VatDocumentPage,
  VatReport,
  VatReportFilter,
  VatReportSide,
} from '@omnivo/contracts';

import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { checkValueSort } from './report-access.js';
import { reportPage } from './report-paging.js';
import { stockMovementReport } from './stock-movement-queries.js';
import { vatDocuments, vatReport } from './vat-queries.js';

type Paged<F> = F & { limit: number; cursor?: string | undefined };

// The step 21c report pages: VAT (accounting.report.read, decision 11) and stock movement
// (inventory.report.read, decision 20). The route checks those; the stock values check
// inventory.stock.value here. The queries live in vat-queries.ts and stock-movement-queries.ts,
// where the worker's export finds them too.
@Injectable()
export class VatStockReportsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  vat(query: VatReportFilter): Promise<VatReport> {
    return this.withTenant((tx) => vatReport(tx, query));
  }

  vatDocuments(query: Paged<VatReportFilter & { side: VatReportSide }>): Promise<VatDocumentPage> {
    return this.withTenant((tx) => vatDocuments(tx, query, reportPage(query)));
  }

  async stockMovement(query: Paged<StockMovementFilter>): Promise<StockMovementReport> {
    const access = await this.permissions.ofCurrentUser();
    const withValue = access.permissions.includes('inventory.stock.value');
    checkValueSort(query.sort, withValue);
    return this.withTenant((tx) =>
      stockMovementReport(tx, query, { withValue, page: reportPage(query) }),
    );
  }
}
