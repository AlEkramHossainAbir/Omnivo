import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { SalesAccountsService } from './sales-accounts.service.js';

type AccountRoutes = typeof routes.salesAccounts;

// Settings → Sales (step 15d), like Settings → Inventory's StockAccountsController
@Controller()
export class SalesAccountsController {
  constructor(private readonly accounts: SalesAccountsService) {}

  @Endpoint(routes.salesAccounts.get)
  get(): Promise<RouteResponse<AccountRoutes['get']>> {
    return this.accounts.get();
  }

  @Endpoint(routes.salesAccounts.update)
  update({
    body,
  }: RouteInput<AccountRoutes['update']>): Promise<RouteResponse<AccountRoutes['update']>> {
    return this.accounts.update(body);
  }
}
