import { Inject, Injectable } from '@nestjs/common';
import type {
  AgingReport,
  ApAgingFilter,
  ApAgingParty,
  ArAgingFilter,
  ArAgingParty,
  PurchaseReport,
  PurchaseReportFilter,
  SalesReport,
  SalesReportFilter,
} from '@omnivo/contracts';

import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { payablesAging, payablesOf, receivablesAging, receivablesOf } from './aging-queries.js';
import { checkCostSort } from './report-access.js';
import { reportPage } from './report-paging.js';
import { purchaseReport, salesReport } from './trade-report-queries.js';

// A page asks with its filters and a page (limit, cursor); an export uses the same queries with
// every row (export.handler.ts)
type Paged<F> = F & { limit: number; cursor?: string | undefined };

// The step 21b report pages: the sales and purchase reports and the two agings. The route checks
// the report's permission (sales.report.read or purchase.report.read); the cost columns check
// inventory.stock.value here. The queries live in trade-report-queries.ts and aging-queries.ts,
// where the worker's export finds them too.
@Injectable()
export class TradeReportsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  async sales(query: Paged<SalesReportFilter>): Promise<SalesReport> {
    const access = await this.permissions.ofCurrentUser();
    const withCost = access.permissions.includes('inventory.stock.value');
    checkCostSort(query.sort, withCost);
    return this.withTenant((tx) => salesReport(tx, query, { withCost, page: reportPage(query) }));
  }

  purchases(query: Paged<PurchaseReportFilter>): Promise<PurchaseReport> {
    return this.withTenant((tx) => purchaseReport(tx, query, { page: reportPage(query) }));
  }

  receivables(query: Paged<ArAgingFilter>): Promise<AgingReport> {
    return this.withTenant((tx) => receivablesAging(tx, query, reportPage(query)));
  }

  receivablesOf(customerId: string, asOf: string): Promise<ArAgingParty> {
    return this.withTenant((tx) => receivablesOf(tx, customerId, asOf));
  }

  payables(query: Paged<ApAgingFilter>): Promise<AgingReport> {
    return this.withTenant((tx) => payablesAging(tx, query, reportPage(query)));
  }

  payablesOf(supplierId: string, asOf: string): Promise<ApAgingParty> {
    return this.withTenant((tx) => payablesOf(tx, supplierId, asOf));
  }
}
