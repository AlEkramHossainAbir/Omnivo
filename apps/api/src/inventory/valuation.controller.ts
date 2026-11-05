import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { StockAccountsService } from './stock-accounts.service.js';
import { StockRevaluationsService } from './stock-revaluations.service.js';

type RevaluationRoutes = typeof routes.stockRevaluations;
type AccountRoutes = typeof routes.stockAccounts;

@Controller()
export class StockRevaluationsController {
  constructor(private readonly revaluations: StockRevaluationsService) {}

  @Endpoint(routes.stockRevaluations.list)
  list({
    query,
  }: RouteInput<RevaluationRoutes['list']>): Promise<RouteResponse<RevaluationRoutes['list']>> {
    return this.revaluations.list(query);
  }

  @Endpoint(routes.stockRevaluations.get)
  get({
    params,
  }: RouteInput<RevaluationRoutes['get']>): Promise<RouteResponse<RevaluationRoutes['get']>> {
    return this.revaluations.get(params.id);
  }

  @Endpoint(routes.stockRevaluations.create)
  create({
    body,
  }: RouteInput<RevaluationRoutes['create']>): Promise<RouteResponse<RevaluationRoutes['create']>> {
    return this.revaluations.create(body);
  }
}

@Controller()
export class StockAccountsController {
  constructor(private readonly accounts: StockAccountsService) {}

  @Endpoint(routes.stockAccounts.get)
  get(): Promise<RouteResponse<AccountRoutes['get']>> {
    return this.accounts.get();
  }

  @Endpoint(routes.stockAccounts.update)
  update({
    body,
  }: RouteInput<AccountRoutes['update']>): Promise<RouteResponse<AccountRoutes['update']>> {
    return this.accounts.update(body);
  }
}
