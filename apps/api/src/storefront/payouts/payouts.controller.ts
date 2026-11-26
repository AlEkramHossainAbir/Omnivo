import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { PayoutsService } from './payouts.service.js';

type Routes = typeof routes.storefrontPayouts;

// Step 28c: Storefront → Shop payouts. Every route needs storefront.payout.manage (the contract
// says so and the guard checks it). The parcels and the match hang on the courier account
// (/storefront/couriers/:id/…), and the setup has its own address, so none of them ever meets
// /storefront/payouts/:id (mine 17)
@Controller()
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Endpoint(routes.storefrontPayouts.setup)
  setup(): Promise<RouteResponse<Routes['setup']>> {
    return this.payouts.setup();
  }

  @Endpoint(routes.storefrontPayouts.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.payouts.list(query);
  }

  @Endpoint(routes.storefrontPayouts.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.payouts.get(params.id);
  }

  @Endpoint(routes.storefrontPayouts.parcels)
  parcels({ params }: RouteInput<Routes['parcels']>): Promise<RouteResponse<Routes['parcels']>> {
    return this.payouts.parcels(params.id);
  }

  @Endpoint(routes.storefrontPayouts.match)
  match({ params, body }: RouteInput<Routes['match']>): Promise<RouteResponse<Routes['match']>> {
    return this.payouts.match(params.id, body);
  }

  @Endpoint(routes.storefrontPayouts.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.payouts.create(body);
  }

  @Endpoint(routes.storefrontPayouts.void)
  void({ params, body }: RouteInput<Routes['void']>): Promise<RouteResponse<Routes['void']>> {
    return this.payouts.void(params.id, body);
  }
}
