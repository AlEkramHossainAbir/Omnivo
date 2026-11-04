import { Inject, Injectable } from '@nestjs/common';
import {
  type Dashboard,
  dashboardCardsFor,
  dashboardPeriods,
  type DashboardQuery,
} from '@omnivo/contracts';

import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import {
  cashCard,
  loadBooks,
  lowStockCard,
  marginCard,
  payablesCard,
  receivablesCard,
  salesCard,
  soldByDay,
  soldFrom,
  topProducts,
} from './dashboard-queries.js';

// The home page (step 21a): one answer with every card the person may see (decision 13). A card
// without its permission is null and its query never runs: what is not read cannot leak, here or
// from the copy the device keeps for offline.
@Injectable()
export class DashboardService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  async get(query: DashboardQuery): Promise<Dashboard> {
    const access = await this.permissions.ofCurrentUser();
    // The contract's list, the one the page draws from (decision 14)
    const cards = new Set(dashboardCardsFor(access.permissions));
    const branchId = query.branchId ?? null;
    return this.withTenant(async (tx) => {
      const books = await loadBooks(tx);
      const periods = dashboardPeriods(books.today);
      // The sales and the margin read the same rows: one query for both
      const needsSold = cards.has('sales') || cards.has('margin');
      // One transaction, so the queries run one after another on its connection; Promise.all
      // only sends them without waiting for each answer
      const [sold, cash, top, receivables, payables, lowStock] = await Promise.all([
        needsSold ? soldByDay(tx, books, soldFrom(periods), branchId) : null,
        cards.has('cash') ? cashCard(tx, books) : null,
        cards.has('topProducts') ? topProducts(tx, periods, branchId) : null,
        cards.has('receivables') ? receivablesCard(tx, books) : null,
        cards.has('payables') ? payablesCard(tx, books) : null,
        cards.has('lowStock') ? lowStockCard(tx) : null,
      ]);
      return {
        today: books.today,
        generatedAt: new Date().toISOString(),
        branchId,
        sales: sold !== null && cards.has('sales') ? salesCard(sold, periods) : null,
        margin: sold !== null && cards.has('margin') ? marginCard(sold, periods) : null,
        cash,
        topProducts: top,
        receivables,
        payables,
        lowStock,
      };
    });
  }
}
