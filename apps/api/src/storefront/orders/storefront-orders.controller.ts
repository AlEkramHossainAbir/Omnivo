import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontOrdersService } from './storefront-orders.service.js';

type Routes = typeof routes.storefrontOrders;
// Step 28b: Delivered, what came back and the COD receipt, a route group of their own (mine 17)
type DeliveryRoutes = typeof routes.storefrontOrderDeliveries;

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

  // Step 28a: before getOrder, for countOrders' reason
  @Endpoint(routes.storefrontOrders.courierExport)
  courierExport(): Promise<RouteResponse<Routes['courierExport']>> {
    return this.orders.courierExport();
  }

  // Step 28a.6: before getOrder too
  @Endpoint(routes.storefrontOrders.courierChoices)
  courierChoices(): Promise<RouteResponse<Routes['courierChoices']>> {
    return this.orders.courierChoices();
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

  @Endpoint(routes.storefrontOrderDeliveries.deliverOrder)
  deliverOrder({
    params,
    body,
  }: RouteInput<DeliveryRoutes['deliverOrder']>): Promise<
    RouteResponse<DeliveryRoutes['deliverOrder']>
  > {
    return this.orders.deliver(params.id, body);
  }

  @Endpoint(routes.storefrontOrderDeliveries.getReturnPlan)
  getReturnPlan({
    params,
  }: RouteInput<DeliveryRoutes['getReturnPlan']>): Promise<
    RouteResponse<DeliveryRoutes['getReturnPlan']>
  > {
    return this.orders.returnPlan(params.id);
  }

  @Endpoint(routes.storefrontOrderDeliveries.partlyDeliverOrder)
  partlyDeliverOrder({
    params,
    body,
  }: RouteInput<DeliveryRoutes['partlyDeliverOrder']>): Promise<
    RouteResponse<DeliveryRoutes['partlyDeliverOrder']>
  > {
    return this.orders.partlyDeliver(params.id, body);
  }

  @Endpoint(routes.storefrontOrderDeliveries.returnOrder)
  returnOrder({
    params,
    body,
  }: RouteInput<DeliveryRoutes['returnOrder']>): Promise<
    RouteResponse<DeliveryRoutes['returnOrder']>
  > {
    return this.orders.returnOrder(params.id, body);
  }

  @Endpoint(routes.storefrontOrderDeliveries.makeCodReceipt)
  makeCodReceipt({
    params,
    body,
  }: RouteInput<DeliveryRoutes['makeCodReceipt']>): Promise<
    RouteResponse<DeliveryRoutes['makeCodReceipt']>
  > {
    return this.orders.makeCodReceipt(params.id, params.shipmentId, body.version);
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

  // Step 28a: "Book courier" and "Book again"
  @Endpoint(routes.storefrontOrders.bookShipment)
  bookShipment({
    params,
    body,
  }: RouteInput<Routes['bookShipment']>): Promise<RouteResponse<Routes['bookShipment']>> {
    return this.orders.bookShipment(params.id, body);
  }

  @Endpoint(routes.storefrontOrders.retryShipment)
  retryShipment({
    params,
    body,
  }: RouteInput<Routes['retryShipment']>): Promise<RouteResponse<Routes['retryShipment']>> {
    return this.orders.retryShipment(params.id, params.shipmentId, body.version);
  }

  @Endpoint(routes.storefrontOrders.cancelOrder)
  cancelOrder({
    params,
    body,
  }: RouteInput<Routes['cancelOrder']>): Promise<RouteResponse<Routes['cancelOrder']>> {
    return this.orders.cancel(params.id, body);
  }
}
