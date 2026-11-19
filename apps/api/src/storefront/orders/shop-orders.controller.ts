import { Controller, Header } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { ShopClient } from '../shop-client.decorator.js';
import { ShopHost } from '../shop-host.decorator.js';
import { ShopOrdersService } from './shop-orders.service.js';

type Routes = typeof routes.publicStorefront;

// Step 27a: the seven routes only the shop's server may call (auth: 'shop', checked by ShopKeyGuard
// before any of these runs). Their own controller, next to the public reads': these write, send
// SMS and answer with a buyer's details. Every answer is no-store, like the reads', and more so:
// an order or a tracking answer in a shared cache would be one buyer's details given to another.
@Controller()
export class ShopOrdersController {
  constructor(private readonly orders: ShopOrdersService) {}

  @Endpoint(routes.publicStorefront.placeOrder)
  @Header('Cache-Control', 'no-store')
  placeOrder(
    { body }: RouteInput<Routes['placeOrder']>,
    @ShopHost() host: string | undefined,
    @ShopClient() client: string,
  ): Promise<RouteResponse<Routes['placeOrder']>> {
    return this.orders.place(host, client, body);
  }

  @Endpoint(routes.publicStorefront.codeWait)
  @Header('Cache-Control', 'no-store')
  codeWait(
    { body }: RouteInput<Routes['codeWait']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['codeWait']>> {
    return this.orders.codeWait(host, body.token);
  }

  @Endpoint(routes.publicStorefront.verifyCode)
  @Header('Cache-Control', 'no-store')
  verifyCode(
    { body }: RouteInput<Routes['verifyCode']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['verifyCode']>> {
    return this.orders.verify(host, body.token, body.code);
  }

  @Endpoint(routes.publicStorefront.resendCode)
  @Header('Cache-Control', 'no-store')
  resendCode(
    { body }: RouteInput<Routes['resendCode']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['resendCode']>> {
    return this.orders.resend(host, body.token);
  }

  @Endpoint(routes.publicStorefront.order)
  @Header('Cache-Control', 'no-store')
  order(
    { body }: RouteInput<Routes['order']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['order']>> {
    return this.orders.find(host, body.orderNo, body.token);
  }

  @Endpoint(routes.publicStorefront.tracking)
  @Header('Cache-Control', 'no-store')
  tracking(
    { body }: RouteInput<Routes['tracking']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['tracking']>> {
    return this.orders.tracking(host, body.token);
  }

  @Endpoint(routes.publicStorefront.track)
  @Header('Cache-Control', 'no-store')
  track(
    { body }: RouteInput<Routes['track']>,
    @ShopHost() host: string | undefined,
    @ShopClient() client: string,
  ): Promise<RouteResponse<Routes['track']>> {
    return this.orders.track(host, client, body);
  }
}
