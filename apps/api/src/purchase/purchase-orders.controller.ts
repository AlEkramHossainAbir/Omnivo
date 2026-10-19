import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { GoodsReceiptsService } from './goods-receipts.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';

type Routes = typeof routes.purchaseOrders;
type ReceiptRoutes = typeof routes.goodsReceipts;

@Controller()
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrdersService) {}

  @Endpoint(routes.purchaseOrders.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.orders.list(query);
  }

  @Endpoint(routes.purchaseOrders.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.orders.get(params.id);
  }

  @Endpoint(routes.purchaseOrders.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.orders.create(body);
  }

  @Endpoint(routes.purchaseOrders.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.orders.update(params.id, body);
  }

  @Endpoint(routes.purchaseOrders.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.orders.remove(params.id, query.version);
  }

  @Endpoint(routes.purchaseOrders.submit)
  submit({ params, body }: RouteInput<Routes['submit']>): Promise<RouteResponse<Routes['submit']>> {
    return this.orders.submit(params.id, body.version);
  }

  @Endpoint(routes.purchaseOrders.reopen)
  reopen({ params, body }: RouteInput<Routes['reopen']>): Promise<RouteResponse<Routes['reopen']>> {
    return this.orders.reopen(params.id, body.version);
  }

  @Endpoint(routes.purchaseOrders.close)
  close({ params, body }: RouteInput<Routes['close']>): Promise<RouteResponse<Routes['close']>> {
    return this.orders.close(params.id, body.version);
  }

  @Endpoint(routes.purchaseOrders.cancel)
  cancel({ params, body }: RouteInput<Routes['cancel']>): Promise<RouteResponse<Routes['cancel']>> {
    return this.orders.cancel(params.id, body.version);
  }
}

@Controller()
export class GoodsReceiptsController {
  constructor(private readonly receipts: GoodsReceiptsService) {}

  @Endpoint(routes.goodsReceipts.list)
  list({
    query,
  }: RouteInput<ReceiptRoutes['list']>): Promise<RouteResponse<ReceiptRoutes['list']>> {
    return this.receipts.list(query);
  }

  @Endpoint(routes.goodsReceipts.get)
  get({ params }: RouteInput<ReceiptRoutes['get']>): Promise<RouteResponse<ReceiptRoutes['get']>> {
    return this.receipts.get(params.id);
  }

  @Endpoint(routes.goodsReceipts.create)
  create({
    body,
  }: RouteInput<ReceiptRoutes['create']>): Promise<RouteResponse<ReceiptRoutes['create']>> {
    return this.receipts.create(body);
  }

  @Endpoint(routes.goodsReceipts.update)
  update({
    params,
    body,
  }: RouteInput<ReceiptRoutes['update']>): Promise<RouteResponse<ReceiptRoutes['update']>> {
    return this.receipts.update(params.id, body);
  }

  @Endpoint(routes.goodsReceipts.remove)
  remove({ params, query }: RouteInput<ReceiptRoutes['remove']>): Promise<void> {
    return this.receipts.remove(params.id, query.version);
  }

  @Endpoint(routes.goodsReceipts.post)
  post({
    params,
    body,
  }: RouteInput<ReceiptRoutes['post']>): Promise<RouteResponse<ReceiptRoutes['post']>> {
    return this.receipts.post(params.id, body.version);
  }
}
