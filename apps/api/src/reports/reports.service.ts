import { Inject, Injectable } from '@nestjs/common';
import type {
  BalanceSheet,
  BalanceSheetQuery,
  ProfitAndLoss,
  ProfitAndLossQuery,
  TrialBalance,
  TrialBalanceQuery,
} from '@omnivo/contracts';

import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { balanceSheet, profitAndLoss, trialBalance } from './report-queries.js';

// The report pages. The queries live in report-queries.ts, where the worker's export job finds
// them too.
@Injectable()
export class ReportsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  trialBalance(query: TrialBalanceQuery): Promise<TrialBalance> {
    return this.withTenant((tx) => trialBalance(tx, query));
  }

  profitAndLoss(query: ProfitAndLossQuery): Promise<ProfitAndLoss> {
    return this.withTenant((tx) => profitAndLoss(tx, query));
  }

  balanceSheet(query: BalanceSheetQuery): Promise<BalanceSheet> {
    return this.withTenant((tx) => balanceSheet(tx, query));
  }
}
