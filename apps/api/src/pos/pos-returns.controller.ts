import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { PosReturnsService } from './pos-returns.service.js';

type Routes = typeof routes.posReturns;

// Step 20c. No route writes a return: it arrives as a sync command, like a sale (decision 21 of
// 20a). These read: the sale a cashier takes goods back from, a register's recent sales for its
// device's copy, and the managers' list and page.
@Controller()
export class PosReturnsController {
  constructor(private readonly returns: PosReturnsService) {}

  @Endpoint(routes.posReturns.registerSales)
  registerSales({
    params,
    query,
  }: RouteInput<Routes['registerSales']>): Promise<RouteResponse<Routes['registerSales']>> {
    return this.returns.registerSales(params.id, query);
  }

  @Endpoint(routes.posReturns.returnableSale)
  returnableSale({
    params,
  }: RouteInput<Routes['returnableSale']>): Promise<RouteResponse<Routes['returnableSale']>> {
    return this.returns.returnableSale(params.number);
  }

  @Endpoint(routes.posReturns.listReturns)
  listReturns({
    query,
  }: RouteInput<Routes['listReturns']>): Promise<RouteResponse<Routes['listReturns']>> {
    return this.returns.list(query);
  }

  @Endpoint(routes.posReturns.getReturn)
  getReturn({
    params,
  }: RouteInput<Routes['getReturn']>): Promise<RouteResponse<Routes['getReturn']>> {
    return this.returns.get(params.id);
  }
}
