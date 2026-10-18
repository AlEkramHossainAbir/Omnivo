import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { CostLookupService } from './cost-lookup.service.js';
import { RequisitionsService } from './requisitions.service.js';

type Routes = typeof routes.requisitions;
type CostRoutes = typeof routes.purchaseCosts;

@Controller()
export class RequisitionsController {
  constructor(private readonly requisitions: RequisitionsService) {}

  @Endpoint(routes.requisitions.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.requisitions.list(query);
  }

  @Endpoint(routes.requisitions.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.requisitions.get(params.id);
  }

  @Endpoint(routes.requisitions.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.requisitions.create(body);
  }

  @Endpoint(routes.requisitions.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.requisitions.update(params.id, body);
  }

  @Endpoint(routes.requisitions.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.requisitions.remove(params.id, query.version);
  }

  @Endpoint(routes.requisitions.submit)
  submit({ params, body }: RouteInput<Routes['submit']>): Promise<RouteResponse<Routes['submit']>> {
    return this.requisitions.submit(params.id, body.version);
  }

  @Endpoint(routes.requisitions.reopen)
  reopen({ params, body }: RouteInput<Routes['reopen']>): Promise<RouteResponse<Routes['reopen']>> {
    return this.requisitions.reopen(params.id, body.version);
  }

  @Endpoint(routes.requisitions.cancel)
  cancel({ params, body }: RouteInput<Routes['cancel']>): Promise<RouteResponse<Routes['cancel']>> {
    return this.requisitions.cancel(params.id, body.version);
  }
}

@Controller()
export class PurchaseCostsController {
  constructor(private readonly costs: CostLookupService) {}

  @Endpoint(routes.purchaseCosts.lookup)
  lookup({ body }: RouteInput<CostRoutes['lookup']>): Promise<RouteResponse<CostRoutes['lookup']>> {
    return this.costs.lookup(body);
  }
}
