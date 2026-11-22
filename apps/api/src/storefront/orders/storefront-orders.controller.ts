import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontOrdersService } from './storefront-orders.service.js';

type Routes = typeof routes.storefrontOrders;

// Step 27b: Storefront → Shop orders, the ERP's side of the shop's orders. The contract names each
// route's permission (storefront.order.read or .manage) and the guard checks it; each route hands
// its parsed input to the service. countOrders is declared before getOrder: Nest matches routes in
// the order they are declared, and /storefront/orders/counts would otherwise reach getOrder with
// "counts" as the id (refused by the uuid check, but as a 400, not the count)
@Controller()
export class StorefrontOrdersController {
  constructor(private readonly orders: StorefrontOrdersService) {}

  @Endpoint(routes.storefrontOrders.listOrders)
  listOrders({
    query,
  }: RouteInput<Routes['listOrders']>): Promise<RouteResponse<Routes['listOrders']>> {
    return this.orders.list(query);
  }

  @Endpoint(routes.storefrontOrders.countOrders)
  countOrders(): Promise<RouteResponse<Routes['countOrders']>> {
    return this.orders.counts();
  }

  @Endpoint(routes.storefrontOrders.getOrder)
  getOrder({ params }: RouteInput<Routes['getOrder']>): Promise<RouteResponse<Routes['getOrder']>> {
    return this.orders.get(params.id);
  }

  @Endpoint(routes.storefrontOrders.makeSalesOrder)
  makeSalesOrder({
    params,
    body,
  }: RouteInput<Routes['makeSalesOrder']>): Promise<RouteResponse<Routes['makeSalesOrder']>> {
    return this.orders.makeSalesOrder(params.id, body.version);
  }

  @Endpoint(routes.storefrontOrders.getPackPlan)
  getPackPlan({
    params,
  }: RouteInput<Routes['getPackPlan']>): Promise<RouteResponse<Routes['getPackPlan']>> {
    return this.orders.packPlan(params.id);
  }

  @Endpoint(routes.storefrontOrders.packOrder)
  packOrder({
    params,
    body,
  }: RouteInput<Routes['packOrder']>): Promise<RouteResponse<Routes['packOrder']>> {
    return this.orders.pack(params.id, body);
  }

  @Endpoint(routes.storefrontOrders.shipOrder)
  shipOrder({
    params,
    body,
  }: RouteInput<Routes['shipOrder']>): Promise<RouteResponse<Routes['shipOrder']>> {
    return this.orders.ship(params.id, body.version);
  }

  @Endpoint(routes.storefrontOrders.deliverOrder)
  deliverOrder({
    params,
    body,
  }: RouteInput<Routes['deliverOrder']>): Promise<RouteResponse<Routes['deliverOrder']>> {
    return this.orders.deliver(params.id, body.version);
  }

  // Step 27d: "Make the receipt" on the Payments card
  @Endpoint(routes.storefrontOrders.makePaymentReceipt)
  makePaymentReceipt({
    params,
    body,
  }: RouteInput<Routes['makePaymentReceipt']>): Promise<
    RouteResponse<Routes['makePaymentReceipt']>
  > {
    return this.orders.makePaymentReceipt(params.id, params.paymentId, body.version);
  }

  @Endpoint(routes.storefrontOrders.cancelOrder)
  cancelOrder({
    params,
    body,
  }: RouteInput<Routes['cancelOrder']>): Promise<RouteResponse<Routes['cancelOrder']>> {
    return this.orders.cancel(params.id, body);
  }
}
