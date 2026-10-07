import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DeliveriesService } from './deliveries.service.js';
import { PriceLookupService } from './price-lookup.service.js';
import { QuotationsService } from './quotations.service.js';
import { SalesOrdersService } from './sales-orders.service.js';

type PriceRoutes = typeof routes.salesPrices;
type QuotationRoutes = typeof routes.quotations;
type OrderRoutes = typeof routes.salesOrders;
type DeliveryRoutes = typeof routes.deliveries;

@Controller()
export class SalesPricesController {
  constructor(private readonly prices: PriceLookupService) {}

  @Endpoint(routes.salesPrices.lookup)
  lookup({
    body,
  }: RouteInput<PriceRoutes['lookup']>): Promise<RouteResponse<PriceRoutes['lookup']>> {
    return this.prices.lookup(body);
  }
}

@Controller()
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Endpoint(routes.quotations.list)
  list({
    query,
  }: RouteInput<QuotationRoutes['list']>): Promise<RouteResponse<QuotationRoutes['list']>> {
    return this.quotations.list(query);
  }

  @Endpoint(routes.quotations.get)
  get({
    params,
  }: RouteInput<QuotationRoutes['get']>): Promise<RouteResponse<QuotationRoutes['get']>> {
    return this.quotations.get(params.id);
  }

  @Endpoint(routes.quotations.create)
  create({
    body,
  }: RouteInput<QuotationRoutes['create']>): Promise<RouteResponse<QuotationRoutes['create']>> {
    return this.quotations.create(body);
  }

  @Endpoint(routes.quotations.update)
  update({
    params,
    body,
  }: RouteInput<QuotationRoutes['update']>): Promise<RouteResponse<QuotationRoutes['update']>> {
    return this.quotations.update(params.id, body);
  }

  @Endpoint(routes.quotations.remove)
  remove({ params, query }: RouteInput<QuotationRoutes['remove']>): Promise<void> {
    return this.quotations.remove(params.id, query.version);
  }

  @Endpoint(routes.quotations.decline)
  decline({
    params,
    body,
  }: RouteInput<QuotationRoutes['decline']>): Promise<RouteResponse<QuotationRoutes['decline']>> {
    return this.quotations.decline(params.id, body.version);
  }

  @Endpoint(routes.quotations.reopen)
  reopen({
    params,
    body,
  }: RouteInput<QuotationRoutes['reopen']>): Promise<RouteResponse<QuotationRoutes['reopen']>> {
    return this.quotations.reopen(params.id, body.version);
  }
}

@Controller()
export class SalesOrdersController {
  constructor(private readonly orders: SalesOrdersService) {}

  @Endpoint(routes.salesOrders.list)
  list({ query }: RouteInput<OrderRoutes['list']>): Promise<RouteResponse<OrderRoutes['list']>> {
    return this.orders.list(query);
  }

  @Endpoint(routes.salesOrders.get)
  get({ params }: RouteInput<OrderRoutes['get']>): Promise<RouteResponse<OrderRoutes['get']>> {
    return this.orders.get(params.id);
  }

  @Endpoint(routes.salesOrders.create)
  create({
    body,
  }: RouteInput<OrderRoutes['create']>): Promise<RouteResponse<OrderRoutes['create']>> {
    return this.orders.create(body);
  }

  @Endpoint(routes.salesOrders.update)
  update({
    params,
    body,
  }: RouteInput<OrderRoutes['update']>): Promise<RouteResponse<OrderRoutes['update']>> {
    return this.orders.update(params.id, body);
  }

  @Endpoint(routes.salesOrders.remove)
  remove({ params, query }: RouteInput<OrderRoutes['remove']>): Promise<void> {
    return this.orders.remove(params.id, query.version);
  }

  @Endpoint(routes.salesOrders.confirm)
  confirm({
    params,
    body,
  }: RouteInput<OrderRoutes['confirm']>): Promise<RouteResponse<OrderRoutes['confirm']>> {
    return this.orders.confirm(params.id, body.version);
  }

  @Endpoint(routes.salesOrders.reopen)
  reopen({
    params,
    body,
  }: RouteInput<OrderRoutes['reopen']>): Promise<RouteResponse<OrderRoutes['reopen']>> {
    return this.orders.reopen(params.id, body.version);
  }

  @Endpoint(routes.salesOrders.close)
  close({
    params,
    body,
  }: RouteInput<OrderRoutes['close']>): Promise<RouteResponse<OrderRoutes['close']>> {
    return this.orders.close(params.id, body.version);
  }

  @Endpoint(routes.salesOrders.cancel)
  cancel({
    params,
    body,
  }: RouteInput<OrderRoutes['cancel']>): Promise<RouteResponse<OrderRoutes['cancel']>> {
    return this.orders.cancel(params.id, body.version);
  }
}

@Controller()
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Endpoint(routes.deliveries.list)
  list({
    query,
  }: RouteInput<DeliveryRoutes['list']>): Promise<RouteResponse<DeliveryRoutes['list']>> {
    return this.deliveries.list(query);
  }

  @Endpoint(routes.deliveries.get)
  get({
    params,
  }: RouteInput<DeliveryRoutes['get']>): Promise<RouteResponse<DeliveryRoutes['get']>> {
    return this.deliveries.get(params.id);
  }

  @Endpoint(routes.deliveries.create)
  create({
    body,
  }: RouteInput<DeliveryRoutes['create']>): Promise<RouteResponse<DeliveryRoutes['create']>> {
    return this.deliveries.create(body);
  }

  @Endpoint(routes.deliveries.update)
  update({
    params,
    body,
  }: RouteInput<DeliveryRoutes['update']>): Promise<RouteResponse<DeliveryRoutes['update']>> {
    return this.deliveries.update(params.id, body);
  }

  @Endpoint(routes.deliveries.remove)
  remove({ params, query }: RouteInput<DeliveryRoutes['remove']>): Promise<void> {
    return this.deliveries.remove(params.id, query.version);
  }

  @Endpoint(routes.deliveries.post)
  post({
    params,
    body,
  }: RouteInput<DeliveryRoutes['post']>): Promise<RouteResponse<DeliveryRoutes['post']>> {
    return this.deliveries.post(params.id, body.version);
  }
}
